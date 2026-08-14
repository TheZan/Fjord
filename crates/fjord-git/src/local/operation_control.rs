//! Continue, skip, and abort repository operations through the resolved system
//! Git. Git owns the sequencer state, so these controls deliberately do not
//! attempt to reproduce its behavior through libgit2.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use fjord_domain::{RepoOperation, RepoOperationState};
use fjord_ports::{GitError, GitOperationContext, GitRemoteError, RepoPath};

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::remote::process_runner::{GitCommandSpec, GitProcessRunner, OutputCapture};

use super::operation_state::OperationOriginTracker;
use super::*;

const OUTPUT_TAIL_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OperationAction {
    Continue,
    Skip,
    Abort,
}

pub(super) async fn run(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    action: OperationAction,
    context: GitOperationContext,
) -> Result<RepoOperationState, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let before = current_state(&repo, &origins)?;
    let args = command_args(action, &before)?;
    let spec = command_spec(commands.executable()?, &repo, args);

    // Even a command that exits unsuccessfully can advance a sequencer to its
    // next (possibly conflicted) step. Invalidate every observable domain once
    // Git has been given control so the detectable state is never hidden.
    let process_result = GitProcessRunner.run(&spec, context, None).await;
    bump_repository_mutation(&repo, MutationKind::OperationStep);
    let result = process_result.map_err(map_process_error)?;
    if result.exit_code != Some(0) {
        return Err(GitError::OperationStepFailed(step_diagnostics(
            &result.stderr_tail,
            &result.stdout,
        )));
    }

    current_state(&repo, &origins)
}

fn current_state(
    repo: &RepoPath,
    origins: &OperationOriginTracker,
) -> Result<RepoOperationState, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        super::operation_state::detect(git, repo, origins)
    })
}

fn command_args(
    action: OperationAction,
    state: &RepoOperationState,
) -> Result<Vec<OsString>, GitError> {
    use OperationAction::{Abort, Continue, Skip};

    if matches!(action, Continue) && !state.conflicted_paths.is_empty() {
        return Err(GitError::OperationHasConflicts {
            paths: state.conflicted_paths.clone(),
        });
    }

    let args: &[&str] = match (&state.operation, action) {
        (RepoOperation::Merge { .. }, Continue) => &["merge", "--continue"],
        (RepoOperation::Merge { .. }, Abort) => &["merge", "--abort"],
        (RepoOperation::Rebase { .. }, Continue) => &["rebase", "--continue"],
        (RepoOperation::Rebase { .. }, Skip) => &["rebase", "--skip"],
        (RepoOperation::Rebase { .. }, Abort) => &["rebase", "--abort"],
        (RepoOperation::CherryPick { .. }, Continue) => &["cherry-pick", "--continue"],
        (RepoOperation::CherryPick { .. }, Skip) => &["cherry-pick", "--skip"],
        (RepoOperation::CherryPick { .. }, Abort) => &["cherry-pick", "--abort"],
        (RepoOperation::Revert { .. }, Continue) => &["revert", "--continue"],
        // Git's sequencer supports this even though the current product only
        // advertises Skip for multi-step rebase and cherry-pick operations.
        (RepoOperation::Revert { .. }, Skip) => &["revert", "--skip"],
        (RepoOperation::Revert { .. }, Abort) => &["revert", "--abort"],
        (RepoOperation::Bisect { .. }, Abort) => &["bisect", "reset"],
        (
            RepoOperation::Normal | RepoOperation::Detached { .. } | RepoOperation::UnbornBranch,
            _,
        ) => return Err(GitError::OperationNotInProgress),
        (_, unavailable) => {
            return Err(GitError::OperationStepFailed(format!(
                "{} is not available for the current repository operation",
                action_name(unavailable)
            )))
        }
    };

    Ok(args.iter().map(OsString::from).collect())
}

fn command_spec(executable: PathBuf, repo: &RepoPath, args: Vec<OsString>) -> GitCommandSpec {
    GitCommandSpec {
        executable,
        cwd: repo.0.clone(),
        args,
        environment: vec![
            ("GIT_EDITOR".into(), "true".into()),
            ("GIT_SEQUENCE_EDITOR".into(), "true".into()),
            ("GIT_MERGE_AUTOEDIT".into(), "no".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ],
        timeout: None,
        stdout_capture: OutputCapture::Tail(OUTPUT_TAIL_LIMIT),
    }
}

fn action_name(action: OperationAction) -> &'static str {
    match action {
        OperationAction::Continue => "continue",
        OperationAction::Skip => "skip",
        OperationAction::Abort => "abort",
    }
}

fn step_diagnostics(stderr: &str, stdout: &str) -> String {
    let diagnostics = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if diagnostics.is_empty() {
        "Git exited without diagnostics".to_string()
    } else {
        diagnostics.to_string()
    }
}

fn map_process_error(error: GitRemoteError) -> GitError {
    match error {
        GitRemoteError::Cancelled => GitError::Cancelled,
        GitRemoteError::GitExecutableNotFound => GitError::ExecutableNotFound,
        other => GitError::OperationStepFailed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(operation: RepoOperation, conflicted_paths: &[&str]) -> RepoOperationState {
        RepoOperationState {
            operation,
            conflicted_paths: conflicted_paths
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
            available: Vec::new(),
            detected_externally: true,
        }
    }

    #[test]
    fn continue_refuses_conflicts_before_building_a_command() {
        let error = command_args(
            OperationAction::Continue,
            &state(
                RepoOperation::CherryPick {
                    commit: "abc".into(),
                },
                &["src/main.rs"],
            ),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            GitError::OperationHasConflicts { paths } if paths == ["src/main.rs"]
        ));
    }

    #[test]
    fn controls_dispatch_to_the_matching_git_sequencer() {
        let cherry_pick = state(
            RepoOperation::CherryPick {
                commit: "abc".into(),
            },
            &[],
        );
        assert_eq!(
            command_args(OperationAction::Continue, &cherry_pick).unwrap(),
            ["cherry-pick", "--continue"]
        );
        assert_eq!(
            command_args(OperationAction::Skip, &cherry_pick).unwrap(),
            ["cherry-pick", "--skip"]
        );
        assert_eq!(
            command_args(OperationAction::Abort, &cherry_pick).unwrap(),
            ["cherry-pick", "--abort"]
        );
    }

    #[test]
    fn subprocess_environment_is_non_interactive() {
        let spec = command_spec(
            "git".into(),
            &RepoPath::new("repo".into()),
            vec!["merge".into(), "--continue".into()],
        );
        assert!(spec
            .environment
            .contains(&("GIT_EDITOR".into(), "true".into())));
        assert!(spec
            .environment
            .contains(&("GIT_SEQUENCE_EDITOR".into(), "true".into())));
        assert!(spec
            .environment
            .contains(&("GIT_TERMINAL_PROMPT".into(), "0".into())));
    }
}
