//! Basic rebase initiation. Git owns the sequencer, including on cancellation.

use std::sync::Arc;

use fjord_domain::{RepoOperation, RepoOperationState};
use fjord_ports::{GitError, GitOperationContext, RepoPath};
use sha2::{Digest, Sha256};

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::remote::process_runner::{GitCommandSpec, GitProcessRunner};

use super::operation_control::{command_spec, map_process_error};
use super::operation_state::{OperationFamily, OperationOriginTracker};
use super::{bump_repository_mutation, LocalGitBackend};

pub(super) async fn run(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    onto: &str,
    context: GitOperationContext,
) -> Result<RepoOperationState, GitError> {
    let _guard = LocalGitBackend::acquire_repo_write_lock(repo).await;
    let before = observe(repo, &origins).await?;
    if !matches!(
        before.state.operation,
        RepoOperation::Normal | RepoOperation::Detached { .. } | RepoOperation::UnbornBranch
    ) {
        return Err(GitError::OperationAlreadyInProgress);
    }
    if onto.is_empty() || onto.contains('\0') {
        return Err(GitError::OperationStepFailed(
            "Invalid rebase target".into(),
        ));
    }
    let spec = rebase_spec(&commands, repo, onto)?;
    let result = GitProcessRunner.run(&spec, context, None).await;

    // Inspect after *every* runner result, including cancellation and non-zero
    // exit. Never abort or remove markers: the Phase 9 controls own that choice.
    origins.record_if_in_progress(repo, OperationFamily::Rebase);
    let after = observe(repo, &origins).await;
    if after.as_ref().is_ok_and(|after| after != &before) {
        bump_repository_mutation(repo, MutationKind::Rebase);
    } else if after.is_err() && !matches!(&result, Err(fjord_ports::GitRemoteError::SpawnFailed(_)))
    {
        // Git had control and the repository can no longer be read. Its old
        // projections cannot be trusted, even though classification must fail.
        bump_repository_mutation(repo, MutationKind::Rebase);
    }
    let result = result.map_err(map_process_error)?;
    let state = after?.state;
    if matches!(state.operation, RepoOperation::Rebase { .. }) {
        return Ok(state);
    }
    if result.exit_code != Some(0) {
        // Do not copy hook output or conflict bodies into IPC diagnostics.
        return Err(GitError::OperationStepFailed(
            "Git could not start rebase".into(),
        ));
    }
    Ok(state)
}

fn rebase_spec(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    onto: &str,
) -> Result<GitCommandSpec, GitError> {
    let mut spec = command_spec(
        commands.executable()?,
        repo,
        [
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.rebaseMerges=false",
            "-c",
            "rebase.autoSquash=false",
            "rebase",
            "--no-autostash",
            "--",
            onto,
        ]
        .into_iter()
        .map(Into::into)
        .collect(),
    );
    // A partial clone must fail locally if an object is missing. The protocol
    // allowlist also prevents implicit transport on Git versions without the
    // lazy-fetch switch. Editor settings come from the shared operation spec.
    spec.environment.extend([
        ("GIT_NO_LAZY_FETCH".into(), "1".into()),
        ("GIT_ALLOW_PROTOCOL".into(), "".into()),
    ]);
    Ok(spec)
}

#[derive(PartialEq, Eq)]
struct Observation {
    state: RepoOperationState,
    head: Option<git2::Oid>,
    head_name: Option<String>,
    head_reflog_len: usize,
    index: [u8; 32],
    working_tree: Vec<(Vec<u8>, u32)>,
}

async fn observe(
    repo: &RepoPath,
    origins: &Arc<OperationOriginTracker>,
) -> Result<Observation, GitError> {
    let repo = repo.clone();
    let origins = origins.clone();
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let state = super::operation_state::detect(git, &repo, &origins)?;
            let head = match git.head() {
                Ok(head) => Some(head),
                Err(error)
                    if matches!(
                        error.code(),
                        git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
                    ) =>
                {
                    None
                }
                Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
            };
            let head_reflog_len = match git.reflog("HEAD") {
                Ok(log) => log.len(),
                Err(error) if error.code() == git2::ErrorCode::NotFound => 0,
                Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
            };
            // Compare semantic index entries, not bytes: a refused rebase may
            // refresh stat information without changing any observable content.
            let index = LocalGitBackend::fresh_index(git)?;
            let mut digest = Sha256::new();
            for entry in index.iter() {
                digest.update((entry.path.len() as u64).to_le_bytes());
                digest.update(&entry.path);
                digest.update(entry.id.as_bytes());
                digest.update(entry.mode.to_le_bytes());
                digest.update((entry.flags & 0x3000).to_le_bytes());
            }
            Ok(Observation {
                state,
                head: head.as_ref().and_then(|head| head.target()),
                head_name: head
                    .as_ref()
                    .map(|head| head.name().map(str::to_owned))
                    .transpose()
                    .map_err(LocalGitBackend::map_git2_error)?,
                head_reflog_len,
                index: digest.finalize().into(),
                working_tree: git
                    .statuses(Some(git2::StatusOptions::new().include_untracked(false)))
                    .map_err(LocalGitBackend::map_git2_error)?
                    .iter()
                    .map(|entry| (entry.path_bytes().to_vec(), entry.status().bits()))
                    .collect(),
            })
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebase_uses_the_resolved_executable_and_one_literal_target_argument() {
        let commands = GitCommandFactory::new();
        commands.apply(fjord_ports::GitExecutableResolution::Resolved(
            "chosen-git".into(),
        ));
        let target = "--exec=touch sentinel; $(whoami)";
        let spec = rebase_spec(&commands, &RepoPath::new("repo".into()), target).unwrap();
        assert_eq!(spec.executable, std::path::PathBuf::from("chosen-git"));
        assert_eq!(&spec.args[spec.args.len() - 2..], ["--", target]);
        assert!(spec.args.contains(&"--no-autostash".into()));
        for (name, value) in [
            ("GIT_EDITOR", "true"),
            ("GIT_SEQUENCE_EDITOR", "true"),
            ("GIT_NO_LAZY_FETCH", "1"),
            ("GIT_ALLOW_PROTOCOL", ""),
        ] {
            assert!(spec.environment.contains(&(name.into(), value.into())));
        }
    }
}
