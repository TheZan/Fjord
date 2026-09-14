//! Basic rebase initiation. Git owns the sequencer, including on cancellation.

use std::sync::Arc;

use super::integration;
use fjord_domain::{
    IntegrationBlocker, MergeDirtyPolicy, MergeSource, PublishedRewriteConsequence,
    RebasePreflight, RebaseResult, RepoOperation, RepoOperationState,
};
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
    run_locked(commands, origins, repo, onto, context, before, false).await
}

async fn run_locked(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    onto: &str,
    context: GitOperationContext,
    before: Observation,
    stashed: bool,
) -> Result<RepoOperationState, GitError> {
    let mutation = if stashed {
        MutationKind::RebaseWithStash
    } else {
        MutationKind::Rebase
    };
    let spec = rebase_spec(&commands, repo, onto).inspect_err(|_| {
        if stashed {
            bump_repository_mutation(repo, mutation);
        }
    })?;
    let result = GitProcessRunner.run(&spec, context, None).await;

    // Inspect after *every* runner result, including cancellation and non-zero
    // exit. Never abort or remove markers: the Phase 9 controls own that choice.
    origins.record_if_in_progress(repo, OperationFamily::Rebase);
    let after = observe(repo, &origins).await;
    if stashed || after.as_ref().is_ok_and(|after| after != &before) {
        bump_repository_mutation(repo, mutation);
    } else if after.is_err() && !matches!(&result, Err(fjord_ports::GitRemoteError::SpawnFailed(_)))
    {
        // Git had control and the repository can no longer be read. Its old
        // projections cannot be trusted, even though classification must fail.
        bump_repository_mutation(repo, mutation);
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

/// Read-only display artifact. All facts are recomputed under the write lock.
pub(super) async fn preflight(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    onto: &MergeSource,
) -> Result<RebasePreflight, GitError> {
    let _guard = LocalGitBackend::acquire_repo_read_lock(repo).await;
    preflight_locked(&commands, repo, onto, &origins).await
}

fn integration_error(error: GitError) -> GitError {
    use IntegrationBlocker::*;
    let blocker = match error {
        GitError::MergeSourceNotFound => TargetNotFound,
        GitError::MergeSourceUnsupported => TargetUnsupported,
        GitError::MergeDetachedHead => DetachedHead,
        GitError::MergeUnbornHead => UnbornHead,
        other => return other,
    };
    GitError::IntegrationBlocked(blocker)
}

async fn preflight_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    onto: &MergeSource,
    origins: &OperationOriginTracker,
) -> Result<RebasePreflight, GitError> {
    // The shared integration engine owns ref/HEAD validation, dirty computation,
    // overwrite intersection and blockers. No parallel rebase safety engine.
    let shared = integration::preflight_locked(repo, onto, origins).map_err(integration_error)?;
    let blockers = shared
        .blockers
        .iter()
        .map(|code| match code.as_str() {
            "merge_source_is_current_branch" => IntegrationBlocker::TargetIsCurrentBranch,
            "merge_source_unsupported" => IntegrationBlocker::TargetUnsupported,
            "operation_already_in_progress" => IntegrationBlocker::OperationAlreadyInProgress,
            "merge_index_has_staged_changes" => IntegrationBlocker::IndexHasStagedChanges,
            "merge_would_overwrite" => IntegrationBlocker::WouldOverwrite,
            _ => IntegrationBlocker::TargetUnsupported, // fail closed on a new shared blocker
        })
        .collect();
    let mut spec = command_spec(
        commands.executable()?,
        repo,
        vec![
            "rev-list".into(),
            "--reverse".into(),
            "--topo-order".into(),
            "--right-only".into(),
            "--cherry-mark".into(),
            "--no-merges".into(),
            format!("{}...{}", shared.source_commit.0, shared.target_commit.0).into(),
            "--".into(),
        ],
    );
    spec.stdout_capture = crate::remote::process_runner::OutputCapture::Full {
        max_bytes: 64 * 1024 * 1024,
    };
    spec.timeout = Some(std::time::Duration::from_secs(30));
    spec.environment.extend([
        ("GIT_NO_LAZY_FETCH".into(), "1".into()),
        ("GIT_ALLOW_PROTOCOL".into(), "".into()),
    ]);
    // Git's own ordering and patch-equivalence decisions, not an approximation
    // of its sequencer. Only object ids are captured, with a fail-closed bound.
    let plan = GitProcessRunner
        .run(&spec, GitOperationContext::default(), None)
        .await
        .map_err(map_process_error)?;
    if plan.exit_code != Some(0) {
        return Err(GitError::OperationStepFailed(
            "Could not read rebase history".into(),
        ));
    }
    let (commits, already_up_to_date, published_rewrite) =
        LocalGitBackend::with_runtime_git2(repo, |git| {
            let head = git2::Oid::from_str(&shared.target_commit.0)
                .map_err(LocalGitBackend::map_git2_error)?;
            let target = git2::Oid::from_str(&shared.source_commit.0)
                .map_err(LocalGitBackend::map_git2_error)?;
            let mut affected = std::collections::HashSet::new();
            let mut walk = git.revwalk().map_err(LocalGitBackend::map_git2_error)?;
            walk.push(head).map_err(LocalGitBackend::map_git2_error)?;
            walk.hide(target).map_err(LocalGitBackend::map_git2_error)?;
            let mut linear = true;
            for id in walk {
                let id = id.map_err(LocalGitBackend::map_git2_error)?;
                linear &= git
                    .find_commit(id)
                    .map_err(LocalGitBackend::map_git2_error)?
                    .parent_count()
                    <= 1;
                affected.insert(id);
            }
            let already_up_to_date = (head == target
                || git
                    .graph_descendant_of(head, target)
                    .map_err(LocalGitBackend::map_git2_error)?)
                && linear;
            let apply = git
                .config()
                .map_err(LocalGitBackend::map_git2_error)?
                .get_string("rebase.backend")
                .is_ok_and(|backend| backend == "apply");
            let mut cursor = Some(target);
            let mut commits = 0u32;
            for line in plan.stdout.lines() {
                let (mark, hex) = line.split_at_checked(1).ok_or_else(|| {
                    GitError::OperationStepFailed("Invalid rebase history".into())
                })?;
                let id = git2::Oid::from_str(hex).map_err(LocalGitBackend::map_git2_error)?;
                let commit = git
                    .find_commit(id)
                    .map_err(LocalGitBackend::map_git2_error)?;
                let parent = if commit.parent_count() == 0 {
                    None
                } else {
                    Some(commit.parent(0).map_err(LocalGitBackend::map_git2_error)?)
                };
                let empty = parent
                    .as_ref()
                    .is_some_and(|parent| commit.tree_id() == parent.tree_id());
                if (mark == "=" && !empty) || (apply && empty) {
                    continue;
                }
                commits = commits.checked_add(1).ok_or_else(|| {
                    GitError::OperationStepFailed("Rebase history exceeds the count limit".into())
                })?;
                // Even a flattened merge history can retain a linear prefix through
                // Git's fast-forward picks. Those published ids are not rewritten.
                if !apply && cursor.is_some() && cursor == parent.as_ref().map(|parent| parent.id())
                {
                    affected.remove(&id);
                    cursor = Some(id);
                } else {
                    cursor = None;
                }
            }
            let branch = git
                .find_branch(&shared.target_branch, git2::BranchType::Local)
                .map_err(LocalGitBackend::map_git2_error)?;
            let upstream = match branch.upstream() {
                Ok(upstream) => Some(upstream),
                Err(error) if error.code() == git2::ErrorCode::NotFound => None,
                Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
            };
            let mut published = None;
            if !already_up_to_date {
                if let Some(upstream) = upstream {
                    let reference = upstream.get();
                    let tip = reference
                        .peel_to_commit()
                        .map_err(LocalGitBackend::map_git2_error)?
                        .id();
                    let mut walk = git.revwalk().map_err(LocalGitBackend::map_git2_error)?;
                    walk.push(tip).map_err(LocalGitBackend::map_git2_error)?;
                    walk.hide(target).map_err(LocalGitBackend::map_git2_error)?;
                    let mut count = 0u32;
                    for id in walk {
                        if affected.contains(&id.map_err(LocalGitBackend::map_git2_error)?) {
                            count = count.checked_add(1).ok_or_else(|| {
                                GitError::OperationStepFailed(
                                    "Published history exceeds the count limit".into(),
                                )
                            })?;
                        }
                    }
                    if count > 0 {
                        published = Some(PublishedRewriteConsequence {
                            upstream: reference
                                .name()
                                .map_err(LocalGitBackend::map_git2_error)?
                                .to_string(),
                            commits: count,
                        });
                    }
                }
            }
            Ok((
                if already_up_to_date { 0 } else { commits },
                already_up_to_date,
                published,
            ))
        })?;
    Ok(RebasePreflight {
        onto: shared.source,
        onto_label: shared.source_label,
        onto_commit: shared.source_commit,
        current_branch: shared.target_branch,
        current_commit: shared.target_commit,
        dirty: shared.dirty,
        blockers,
        commits,
        already_up_to_date,
        published_rewrite,
        generations: shared.generations,
    })
}

pub(super) async fn run_preflighted(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    expected: &RebasePreflight,
    policy: MergeDirtyPolicy,
    context: GitOperationContext,
) -> Result<RebaseResult, GitError> {
    let _guard = LocalGitBackend::acquire_repo_write_lock(repo).await;
    let current = preflight_locked(&commands, repo, &expected.onto, &origins).await?;
    if &current != expected {
        return Err(GitError::PreflightStale);
    }
    for blocker in &current.blockers {
        if !matches!(
            blocker,
            IntegrationBlocker::IndexHasStagedChanges | IntegrationBlocker::WouldOverwrite
        ) || policy == MergeDirtyPolicy::Refuse
        {
            return Err(GitError::IntegrationBlocked(*blocker));
        }
    }
    let before = observe(repo, &origins).await?;
    if current.already_up_to_date {
        return Ok(RebaseResult {
            state: before.state,
            stash_ref: None,
            generations: current.generations,
        });
    }
    // Explicit stash may also be selected for unrelated tracked changes, since
    // system Git itself requires those clean. They stay outside shared blockers.
    commands.executable()?;
    let needs_stash = policy == MergeDirtyPolicy::StashFirst
        && (current.dirty.staged > 0
            || current.dirty.modified > 0
            || !current.dirty.would_overwrite.is_empty());
    let mut stash_id = None;
    if needs_stash {
        context.emit(fjord_ports::GitProgress {
            completed: 0,
            total: 0,
            message: Some("Stashing local changes".into()),
        });
        let (created, result) = integration::stash(
            &commands,
            repo,
            format!(
                "Fjord rebase: {} -> {}",
                current.current_branch, current.onto_label
            ),
            context.clone(),
        )
        .await;
        if created {
            stash_id = integration::stash_tip(repo)?;
        }
        if let Err(error) = result {
            if created {
                bump_repository_mutation(repo, MutationKind::RebaseWithStash);
            }
            return Err(retained(repo, stash_id.as_deref(), error));
        }
        let validation = preflight_locked(&commands, repo, &expected.onto, &origins)
            .await
            .and_then(|after| {
                if after.current_branch != current.current_branch
                    || after.current_commit != current.current_commit
                    || after.onto_commit != current.onto_commit
                    || after.published_rewrite != current.published_rewrite
                {
                    return Err(GitError::PreflightStale);
                }
                if let Some(blocker) = after.blockers.first() {
                    return Err(GitError::IntegrationBlocked(*blocker));
                }
                Ok(())
            });
        if let Err(error) = validation {
            if created {
                bump_repository_mutation(repo, MutationKind::RebaseWithStash);
            }
            return Err(retained(repo, stash_id.as_deref(), error));
        }
    }
    // The immutable resolved commit is the operand; a ref cannot move between
    // this revalidation and Git's resolution and silently change the preview.
    let result = run_locked(
        commands,
        origins,
        repo,
        &current.onto_commit.0,
        context,
        before,
        stash_id.is_some(),
    )
    .await;
    let state = result.map_err(|error| retained(repo, stash_id.as_deref(), error))?;
    Ok(RebaseResult {
        state,
        stash_ref: stash_id
            .as_deref()
            .map(|id| integration::stash_ref(repo, id)),
        generations: super::repository_generations(repo)?,
    })
}

fn retained(repo: &RepoPath, stash: Option<&str>, error: GitError) -> GitError {
    match stash {
        Some(id) => GitError::IntegrationStashRetained {
            stash_ref: integration::stash_ref(repo, id),
            source: Box::new(error),
        },
        None => error,
    }
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
