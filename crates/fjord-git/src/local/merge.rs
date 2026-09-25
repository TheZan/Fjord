//! Branch merge preflight and execution through the resolved system Git.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use fjord_domain::{
    CommitId, MergeDirtyPolicy, MergeMode, MergeOutcome, MergePrediction, MergePreflight,
    MergeResult, MergeSource, MergeStrategyOption, RepoOperation, SquashMergeOutcome,
    SquashMergeResult,
};
use fjord_ports::{GitError, GitOperationContext, GitRemoteError, RepoPath};

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::remote::process_runner::{
    GitCommandResult, GitCommandSpec, GitProcessRunner, OutputCapture,
};

use super::integration::{dirty_error, preflight_locked, reject_hard_blockers};
use super::operation_state::{OperationFamily, OperationOriginTracker};
use super::*;

const OUTPUT_TAIL_LIMIT: usize = 64 * 1024;
/// Upper bound on a user-confirmed merge-commit message, in UTF-8 bytes.
pub(super) const MERGE_MESSAGE_LIMIT: usize = 4 * 1024;

pub(super) struct MergeOptions {
    pub mode: MergeMode,
    pub dirty_policy: MergeDirtyPolicy,
    pub allow_unrelated_histories: bool,
    /// `None` keeps Git's default message; `Some` is committed verbatim.
    pub message: Option<String>,
    /// `-X ours|theirs` (branch-merge §10.4); `None` leaves conflicts to the user.
    pub strategy_option: Option<MergeStrategyOption>,
}

/// Validates and normalizes a user-confirmed merge message (branch-merge §10.1):
/// CRLF/CR become LF, NUL is refused, the result must be non-blank and at most
/// [`MERGE_MESSAGE_LIMIT`] bytes.
pub(super) fn normalize_message(message: &str) -> Result<String, GitError> {
    if message.contains('\0') {
        return Err(GitError::MergeMessageInvalid);
    }
    let normalized = message.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.trim().is_empty() || normalized.len() > MERGE_MESSAGE_LIMIT {
        return Err(GitError::MergeMessageInvalid);
    }
    Ok(normalized)
}

/// `git merge` arguments for one validated request. The source and the
/// message are each a single argument, and a strategy option is `-X` followed
/// by its own `ours`/`theirs` argument; nothing is ever joined into a shell
/// string.
pub(super) fn merge_args(
    mode: MergeMode,
    strategy_option: Option<MergeStrategyOption>,
    allow_unrelated_histories: bool,
    message: Option<&str>,
    ref_name: &str,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("merge")];
    match mode {
        MergeMode::FastForwardOnly => args.push("--ff-only".into()),
        MergeMode::NoFastForward => args.push("--no-ff".into()),
        MergeMode::Default => {}
    }
    if let Some(option) = strategy_option {
        args.push("-X".into());
        // The merge target is the checked-out branch, which Git calls "ours".
        args.push(match option {
            MergeStrategyOption::PreferTarget => "ours".into(),
            MergeStrategyOption::PreferSource => "theirs".into(),
        });
    }
    if allow_unrelated_histories {
        args.push("--allow-unrelated-histories".into());
    }
    if let Some(message) = message {
        args.push("-m".into());
        args.push(message.into());
    }
    args.extend([
        OsString::from("--no-edit"),
        OsString::from("--"),
        OsString::from(ref_name),
    ]);
    args
}

pub(super) async fn preflight(
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    source: &MergeSource,
) -> Result<MergePreflight, GitError> {
    let repo = repo.clone();
    let source = source.clone();
    let _guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || preflight_locked(&repo, &source, &origins))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn run(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    source: &MergeSource,
    options: MergeOptions,
    context: GitOperationContext,
) -> Result<MergeResult, GitError> {
    let message = options
        .message
        .as_deref()
        .map(normalize_message)
        .transpose()?;
    let repo = repo.clone();
    let source = source.clone();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let mut preflight = preflight_locked(&repo, &source, &origins)?;

    reject_hard_blockers(&preflight)?;

    if matches!(preflight.prediction, MergePrediction::AlreadyUpToDate) {
        return Ok(result_from_preflight(
            preflight,
            MergeOutcome::AlreadyUpToDate,
            None,
        ));
    }

    if matches!(preflight.prediction, MergePrediction::Unrelated)
        && !options.allow_unrelated_histories
    {
        return Err(GitError::MergeUnrelatedHistoriesNotAllowed);
    }

    let dirty_blocked = preflight.dirty.staged > 0 || !preflight.dirty.would_overwrite.is_empty();
    if dirty_blocked && options.dirty_policy == MergeDirtyPolicy::Refuse {
        return Err(dirty_error(&preflight));
    }

    let mut stashed = false;
    if dirty_blocked {
        context.emit(fjord_ports::GitProgress {
            completed: 0,
            total: 0,
            message: Some("Stashing local changes".into()),
        });
        let message = format!(
            "Fjord merge: {} -> {}",
            preflight.source_label, preflight.target_branch
        );
        let (created, stash_result) =
            integration::stash(&commands, &repo, message, context.clone()).await;
        stashed = created;
        if let Err(error) = stash_result {
            bump_repository_mutation(&repo, MutationKind::Merge { stash: stashed });
            return Err(retain_stash(merge_stash_error(error), stashed));
        }

        // The source and HEAD are still re-resolved under the same write lock
        // after Git has changed the index/worktree.
        let after_stash = match preflight_locked(&repo, &source, &origins) {
            Ok(value) => value,
            Err(error) => {
                bump_repository_mutation(&repo, MutationKind::Merge { stash: true });
                return Err(retain_stash(error, true));
            }
        };
        if let Err(error) = reject_hard_blockers(&after_stash) {
            bump_repository_mutation(&repo, MutationKind::Merge { stash: true });
            return Err(retain_stash(error, true));
        }
        if after_stash.dirty.staged > 0 || !after_stash.dirty.would_overwrite.is_empty() {
            bump_repository_mutation(&repo, MutationKind::Merge { stash: true });
            return Err(retain_stash(dirty_error(&after_stash), true));
        }
    }

    context.emit(fjord_ports::GitProgress {
        completed: 0,
        total: 0,
        message: Some(format!(
            "Merging {} into {}",
            preflight.source_label, preflight.target_branch
        )),
    });
    let args = merge_args(
        options.mode,
        options.strategy_option,
        matches!(preflight.prediction, MergePrediction::Unrelated),
        message.as_deref(),
        &preflight.source.ref_name,
    );
    let executable = match commands.executable() {
        Ok(executable) => executable,
        Err(error) => {
            if stashed {
                bump_repository_mutation(&repo, MutationKind::Merge { stash: true });
            }
            return Err(retain_stash(error, stashed));
        }
    };
    let process_result = GitProcessRunner
        .run(&command_spec(executable, &repo, args), context, None)
        .await;

    bump_repository_mutation(&repo, MutationKind::Merge { stash: stashed });
    preflight.generations = repository_generations(&repo)?;
    let stash_ref = stashed.then(|| "stash@{0}".to_string());
    let result = match process_result {
        Err(error) => {
            origins.record_if_in_progress(&repo, OperationFamily::Merge);
            return Err(retain_stash(map_process_error(error), stashed));
        }
        Ok(result) => result,
    };

    origins.record_if_in_progress(&repo, OperationFamily::Merge);
    let state = current_state(&repo, &origins).map_err(|error| retain_stash(error, stashed))?;
    if matches!(state.operation, RepoOperation::Merge { .. }) {
        return Ok(result_from_preflight(
            preflight,
            MergeOutcome::Conflicted { state },
            stash_ref,
        ));
    }

    if result.exit_code != Some(0) {
        if options.mode == MergeMode::FastForwardOnly {
            return Err(retain_stash(GitError::MergeNotFastForward, stashed));
        }
        return Err(retain_stash(
            GitError::MergeFailed(diagnostics(&result)),
            stashed,
        ));
    }

    origins.clear(&repo);
    let head = head_id(&repo).map_err(|error| retain_stash(error, stashed))?;
    let outcome = match preflight.prediction {
        // `--no-ff` records a merge commit even where the history would
        // fast-forward, so this outcome follows the mode, not the prediction.
        MergePrediction::FastForward { .. } if options.mode == MergeMode::NoFastForward => {
            MergeOutcome::Merged { commit: head }
        }
        MergePrediction::FastForward { .. } => MergeOutcome::FastForwarded { head },
        MergePrediction::MergeCommit { .. } => MergeOutcome::Merged { commit: head },
        MergePrediction::Unrelated => MergeOutcome::Merged { commit: head },
        MergePrediction::AlreadyUpToDate => MergeOutcome::AlreadyUpToDate,
    };
    Ok(result_from_preflight(preflight, outcome, stash_ref))
}

/// `merge --squash`: reuses the exact same preflight, blockers, and dirty
/// (stash-first) policy as an ordinary merge (`run` above). It never sets
/// `MERGE_HEAD`, so a conflicted squash is detected from the index directly
/// rather than through `RepoOperationState`, and no ref moves on any
/// outcome — the caller can always discard a squash's staged/conflicted
/// changes with a plain Reset (Hard) to `target_commit`, reusing the
/// existing destructive-preflight `Reset` action instead of a second abort
/// mechanism.
pub(super) async fn run_squash(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    source: &MergeSource,
    dirty_policy: MergeDirtyPolicy,
    allow_unrelated_histories: bool,
    context: GitOperationContext,
) -> Result<SquashMergeResult, GitError> {
    let repo = repo.clone();
    let source = source.clone();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let mut preflight = preflight_locked(&repo, &source, &origins)?;

    reject_hard_blockers(&preflight)?;

    if matches!(preflight.prediction, MergePrediction::AlreadyUpToDate) {
        return Ok(squash_result_from_preflight(
            preflight,
            SquashMergeOutcome::AlreadyUpToDate,
            None,
        ));
    }

    if matches!(preflight.prediction, MergePrediction::Unrelated) && !allow_unrelated_histories {
        return Err(GitError::MergeUnrelatedHistoriesNotAllowed);
    }

    let dirty_blocked = preflight.dirty.staged > 0 || !preflight.dirty.would_overwrite.is_empty();
    if dirty_blocked && dirty_policy == MergeDirtyPolicy::Refuse {
        return Err(dirty_error(&preflight));
    }

    let mut stashed = false;
    if dirty_blocked {
        context.emit(fjord_ports::GitProgress {
            completed: 0,
            total: 0,
            message: Some("Stashing local changes".into()),
        });
        let message = format!(
            "Fjord squash merge: {} -> {}",
            preflight.source_label, preflight.target_branch
        );
        let (created, stash_result) =
            integration::stash(&commands, &repo, message, context.clone()).await;
        stashed = created;
        if let Err(error) = stash_result {
            bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: stashed });
            return Err(retain_stash(merge_stash_error(error), stashed));
        }

        // The source and HEAD are still re-resolved under the same write lock
        // after Git has changed the index/worktree.
        let after_stash = match preflight_locked(&repo, &source, &origins) {
            Ok(value) => value,
            Err(error) => {
                bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: true });
                return Err(retain_stash(error, true));
            }
        };
        if let Err(error) = reject_hard_blockers(&after_stash) {
            bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: true });
            return Err(retain_stash(error, true));
        }
        if after_stash.dirty.staged > 0 || !after_stash.dirty.would_overwrite.is_empty() {
            bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: true });
            return Err(retain_stash(dirty_error(&after_stash), true));
        }
    }

    context.emit(fjord_ports::GitProgress {
        completed: 0,
        total: 0,
        message: Some(format!(
            "Squash merging {} into {}",
            preflight.source_label, preflight.target_branch
        )),
    });
    let mut args = vec![OsString::from("merge"), OsString::from("--squash")];
    if matches!(preflight.prediction, MergePrediction::Unrelated) {
        args.push(OsString::from("--allow-unrelated-histories"));
    }
    args.extend([
        OsString::from("--"),
        OsString::from(&preflight.source.ref_name),
    ]);
    let executable = match commands.executable() {
        Ok(executable) => executable,
        Err(error) => {
            if stashed {
                bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: true });
            }
            return Err(retain_stash(error, stashed));
        }
    };
    let process_result = GitProcessRunner
        .run(&command_spec(executable, &repo, args), context, None)
        .await;

    bump_repository_mutation(&repo, MutationKind::SquashMerge { stash: stashed });
    preflight.generations = repository_generations(&repo)?;
    let stash_ref = stashed.then(|| "stash@{0}".to_string());

    let result = match process_result {
        Err(error) => return Err(retain_stash(map_process_error(error), stashed)),
        Ok(result) => result,
    };

    let conflicted = conflicted_paths_now(&repo).map_err(|error| retain_stash(error, stashed))?;
    if !conflicted.is_empty() {
        return Ok(squash_result_from_preflight(
            preflight,
            SquashMergeOutcome::Conflicted { paths: conflicted },
            stash_ref,
        ));
    }

    if result.exit_code != Some(0) {
        return Err(retain_stash(
            GitError::MergeFailed(diagnostics(&result)),
            stashed,
        ));
    }

    let message = squash_message(&repo).map_err(|error| retain_stash(error, stashed))?;
    Ok(squash_result_from_preflight(
        preflight,
        SquashMergeOutcome::Staged { message },
        stash_ref,
    ))
}

fn squash_result_from_preflight(
    preflight: MergePreflight,
    outcome: SquashMergeOutcome,
    stash_ref: Option<String>,
) -> SquashMergeResult {
    SquashMergeResult {
        outcome,
        source: preflight.source,
        source_label: preflight.source_label,
        target_branch: preflight.target_branch,
        target_commit: preflight.target_commit,
        stash_ref,
        generations: preflight.generations,
    }
}

fn conflicted_paths_now(repo: &RepoPath) -> Result<Vec<String>, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        Ok(LocalGitBackend::conflict_paths(
            &LocalGitBackend::fresh_index(git)?,
        ))
    })
}

/// Bounded read of `.git/SQUASH_MSG`, Git's own suggested commit message for
/// the squash. Missing (e.g. a backend that never wrote one) reads as empty
/// rather than an error.
fn squash_message(repo: &RepoPath) -> Result<String, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let bytes = std::fs::read(git.path().join("SQUASH_MSG")).unwrap_or_default();
        let bounded = &bytes[..bytes.len().min(OUTPUT_TAIL_LIMIT)];
        Ok(String::from_utf8_lossy(bounded).into_owned())
    })
}

fn result_from_preflight(
    preflight: MergePreflight,
    outcome: MergeOutcome,
    stash_ref: Option<String>,
) -> MergeResult {
    MergeResult {
        outcome,
        source: preflight.source,
        source_label: preflight.source_label,
        target_branch: preflight.target_branch,
        stash_ref,
        generations: preflight.generations,
    }
}

fn current_state(
    repo: &RepoPath,
    origins: &OperationOriginTracker,
) -> Result<fjord_domain::RepoOperationState, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        super::operation_state::detect(git, repo, origins)
    })
}

fn retain_stash(error: GitError, stashed: bool) -> GitError {
    if stashed {
        GitError::MergeStashRetained(Box::new(error))
    } else {
        error
    }
}

fn head_id(repo: &RepoPath) -> Result<CommitId, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        Ok(CommitId(
            git.head()
                .map_err(LocalGitBackend::map_git2_error)?
                .peel_to_commit()
                .map_err(LocalGitBackend::map_git2_error)?
                .id()
                .to_string(),
        ))
    })
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

fn diagnostics(result: &GitCommandResult) -> String {
    let value = if result.stderr_tail.trim().is_empty() {
        result.stdout.trim()
    } else {
        result.stderr_tail.trim()
    };
    if value.is_empty() {
        "Git exited without diagnostics".into()
    } else {
        value.to_string()
    }
}

// Preserve shipped merge IPC codes when consuming the neutral stash primitive.
fn merge_stash_error(error: GitError) -> GitError {
    match error {
        GitError::OperationStepFailed(message) => GitError::MergeFailed(message),
        other => other,
    }
}

fn map_process_error(error: GitRemoteError) -> GitError {
    match error {
        GitRemoteError::Cancelled => GitError::Cancelled,
        GitRemoteError::GitExecutableNotFound => GitError::ExecutableNotFound,
        other => GitError::MergeFailed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    }

    #[test]
    fn merge_args_per_mode_keep_the_message_one_argument() {
        let message = "Merge branch 'x'; rm -rf / $(whoami)\n\nBody";
        assert_eq!(
            strings(merge_args(
                MergeMode::Default,
                None,
                false,
                Some(message),
                "refs/heads/x"
            )),
            ["merge", "-m", message, "--no-edit", "--", "refs/heads/x"]
        );
        assert_eq!(
            strings(merge_args(
                MergeMode::NoFastForward,
                None,
                false,
                Some(message),
                "refs/heads/x"
            )),
            [
                "merge",
                "--no-ff",
                "-m",
                message,
                "--no-edit",
                "--",
                "refs/heads/x"
            ]
        );
        assert_eq!(
            strings(merge_args(
                MergeMode::FastForwardOnly,
                None,
                false,
                None,
                "refs/heads/x"
            )),
            ["merge", "--ff-only", "--no-edit", "--", "refs/heads/x"]
        );
        assert_eq!(
            strings(merge_args(
                MergeMode::Default,
                None,
                true,
                None,
                "refs/tags/v1"
            )),
            [
                "merge",
                "--allow-unrelated-histories",
                "--no-edit",
                "--",
                "refs/tags/v1"
            ]
        );
    }

    #[test]
    fn strategy_options_are_two_separate_arguments_naming_git_sides() {
        assert_eq!(
            strings(merge_args(
                MergeMode::Default,
                Some(MergeStrategyOption::PreferTarget),
                false,
                Some("Merge branch 'x'"),
                "refs/heads/x"
            )),
            [
                "merge",
                "-X",
                "ours",
                "-m",
                "Merge branch 'x'",
                "--no-edit",
                "--",
                "refs/heads/x"
            ]
        );
        assert_eq!(
            strings(merge_args(
                MergeMode::NoFastForward,
                Some(MergeStrategyOption::PreferSource),
                true,
                None,
                "refs/remotes/origin/x"
            )),
            [
                "merge",
                "--no-ff",
                "-X",
                "theirs",
                "--allow-unrelated-histories",
                "--no-edit",
                "--",
                "refs/remotes/origin/x"
            ]
        );
        // No option means no `-X` at all: conflicts stay the user's.
        assert!(
            !strings(merge_args(MergeMode::Default, None, false, None, "x"))
                .contains(&"-X".to_string())
        );
    }

    #[test]
    fn normalize_message_bounds_and_normalizes() {
        assert_eq!(
            normalize_message("Subject\r\n\r\nBody\rMore").unwrap(),
            "Subject\n\nBody\nMore"
        );
        assert!(matches!(
            normalize_message("a\0b"),
            Err(GitError::MergeMessageInvalid)
        ));
        assert!(matches!(
            normalize_message(" \r\n\t"),
            Err(GitError::MergeMessageInvalid)
        ));
        assert!(normalize_message(&"x".repeat(MERGE_MESSAGE_LIMIT)).is_ok());
        assert!(matches!(
            normalize_message(&"x".repeat(MERGE_MESSAGE_LIMIT + 1)),
            Err(GitError::MergeMessageInvalid)
        ));
        // The bound is in UTF-8 bytes, not characters.
        assert!(matches!(
            normalize_message(&"é".repeat(MERGE_MESSAGE_LIMIT / 2 + 1)),
            Err(GitError::MergeMessageInvalid)
        ));
    }
}
