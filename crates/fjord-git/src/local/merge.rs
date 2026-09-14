//! Branch merge preflight and execution through the resolved system Git.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use fjord_domain::{
    CommitId, MergeDirtyPolicy, MergeMode, MergeOutcome, MergePrediction, MergePreflight,
    MergeResult, MergeSource, RepoOperation, SquashMergeOutcome, SquashMergeResult,
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
    mode: MergeMode,
    dirty_policy: MergeDirtyPolicy,
    context: GitOperationContext,
) -> Result<MergeResult, GitError> {
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
    let mut args = vec!["merge".into()];
    if mode == MergeMode::FastForwardOnly {
        args.push("--ff-only".into());
    }
    args.extend([
        OsString::from("--no-edit"),
        OsString::from("--"),
        OsString::from(&preflight.source.ref_name),
    ]);
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
        if mode == MergeMode::FastForwardOnly {
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
        MergePrediction::FastForward { .. } => MergeOutcome::FastForwarded { head },
        MergePrediction::MergeCommit { .. } => MergeOutcome::Merged { commit: head },
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
    let args = vec![
        OsString::from("merge"),
        OsString::from("--squash"),
        OsString::from("--"),
        OsString::from(&preflight.source.ref_name),
    ];
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
