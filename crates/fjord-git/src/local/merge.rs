//! Branch merge preflight and execution through the resolved system Git.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use fjord_domain::{
    CommitId, MergeDirtyPolicy, MergeDirtyState, MergeMode, MergeOutcome, MergePrediction,
    MergePreflight, MergeResult, MergeSource, MergeSourceKind, RepoOperation,
};
use fjord_ports::{GitError, GitOperationContext, GitRemoteError, RepoPath};

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::remote::process_runner::{
    GitCommandResult, GitCommandSpec, GitProcessRunner, OutputCapture,
};

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
        let stash_before = stash_tip(&repo)?;
        let stash_result = GitProcessRunner
            .run(
                &command_spec(
                    commands.executable()?,
                    &repo,
                    vec![
                        "stash".into(),
                        "push".into(),
                        "--include-untracked".into(),
                        "--message".into(),
                        message.into(),
                    ],
                ),
                context.clone(),
                None,
            )
            .await;
        stashed = stash_tip(&repo)? != stash_before;
        match stash_result {
            Ok(result) if result.exit_code == Some(0) && stashed => {}
            Ok(result) => {
                bump_repository_mutation(&repo, MutationKind::Merge { stash: stashed });
                return Err(retain_stash(
                    GitError::MergeFailed(diagnostics(&result)),
                    stashed,
                ));
            }
            Err(error) => {
                bump_repository_mutation(&repo, MutationKind::Merge { stash: stashed });
                return Err(retain_stash(map_process_error(error), stashed));
            }
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

fn preflight_locked(
    repo: &RepoPath,
    source: &MergeSource,
    origins: &OperationOriginTracker,
) -> Result<MergePreflight, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let state = super::operation_state::detect(git, repo, origins)?;
        let actual_kind = classify_source(&source.ref_name)?;
        if actual_kind != source.kind {
            return preflight_for_unsupported(git, repo, source, origins);
        }
        let source_ref =
            git.find_reference(&source.ref_name)
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::MergeSourceNotFound,
                    _ => LocalGitBackend::map_git2_error(error),
                })?;
        let source_commit = source_ref
            .peel_to_commit()
            .map_err(LocalGitBackend::map_git2_error)?;
        let head = git.head().map_err(|error| match error.code() {
            ErrorCode::UnbornBranch | ErrorCode::NotFound => GitError::MergeUnbornHead,
            _ => LocalGitBackend::map_git2_error(error),
        })?;
        if !head.is_branch() {
            return Err(GitError::MergeDetachedHead);
        }
        let target_ref = head.name().map_err(LocalGitBackend::map_git2_error)?;
        let target_branch = target_ref
            .strip_prefix("refs/heads/")
            .ok_or(GitError::MergeDetachedHead)?
            .to_string();
        let target_commit = head
            .peel_to_commit()
            .map_err(LocalGitBackend::map_git2_error)?;
        let source_label = strip_ref_prefix(&source.ref_name);
        let (ahead, behind) = git
            .graph_ahead_behind(source_commit.id(), target_commit.id())
            .map_err(LocalGitBackend::map_git2_error)?;
        let prediction = if ahead == 0 {
            MergePrediction::AlreadyUpToDate
        } else if behind == 0 {
            MergePrediction::FastForward {
                commits: bounded_count(ahead),
            }
        } else {
            MergePrediction::MergeCommit {
                ahead: bounded_count(ahead),
                behind: bounded_count(behind),
            }
        };
        let dirty = dirty_state(git, &source.ref_name)?;
        let mut blockers = Vec::new();
        if source.ref_name == target_ref {
            blockers.push("merge_source_is_current_branch".into());
        }
        if !matches!(state.operation, RepoOperation::Normal) {
            blockers.push("operation_already_in_progress".into());
        }
        if dirty.staged > 0 {
            blockers.push("merge_index_has_staged_changes".into());
        }
        if !dirty.would_overwrite.is_empty() {
            blockers.push("merge_would_overwrite".into());
        }

        Ok(MergePreflight {
            source: source.clone(),
            source_label,
            source_commit: CommitId(source_commit.id().to_string()),
            target_branch,
            target_commit: CommitId(target_commit.id().to_string()),
            prediction,
            dirty,
            blockers,
            generations: repository_generations(repo)?,
        })
    })
}

fn preflight_for_unsupported(
    git: &mut git2::Repository,
    repo: &RepoPath,
    source: &MergeSource,
    origins: &OperationOriginTracker,
) -> Result<MergePreflight, GitError> {
    let _ = super::operation_state::detect(git, repo, origins)?;
    let source_ref = git
        .find_reference(&source.ref_name)
        .map_err(|error| match error.code() {
            ErrorCode::NotFound => GitError::MergeSourceNotFound,
            _ => LocalGitBackend::map_git2_error(error),
        })?;
    let source_commit = source_ref
        .peel_to_commit()
        .map_err(LocalGitBackend::map_git2_error)?;
    let head = git.head().map_err(|error| match error.code() {
        ErrorCode::UnbornBranch | ErrorCode::NotFound => GitError::MergeUnbornHead,
        _ => LocalGitBackend::map_git2_error(error),
    })?;
    if !head.is_branch() {
        return Err(GitError::MergeDetachedHead);
    }
    let target_commit = head
        .peel_to_commit()
        .map_err(LocalGitBackend::map_git2_error)?;
    let target_branch = head
        .name()
        .map_err(LocalGitBackend::map_git2_error)?
        .strip_prefix("refs/heads/")
        .ok_or(GitError::MergeDetachedHead)?
        .to_string();
    Ok(MergePreflight {
        source: source.clone(),
        source_label: strip_ref_prefix(&source.ref_name),
        source_commit: CommitId(source_commit.id().to_string()),
        target_branch,
        target_commit: CommitId(target_commit.id().to_string()),
        prediction: MergePrediction::AlreadyUpToDate,
        dirty: MergeDirtyState {
            staged: 0,
            modified: 0,
            untracked: 0,
            would_overwrite: Vec::new(),
        },
        blockers: vec!["merge_source_unsupported".into()],
        generations: repository_generations(repo)?,
    })
}

/// Display label for a merge source: the branch or remote-tracking name
/// without its `refs/heads/` or `refs/remotes/` qualifier.
fn strip_ref_prefix(ref_name: &str) -> String {
    ref_name
        .strip_prefix("refs/heads/")
        .or_else(|| ref_name.strip_prefix("refs/remotes/"))
        .unwrap_or(ref_name)
        .to_string()
}

fn classify_source(ref_name: &str) -> Result<MergeSourceKind, GitError> {
    if ref_name.starts_with("refs/heads/") {
        Ok(MergeSourceKind::LocalBranch)
    } else if ref_name.starts_with("refs/remotes/") {
        Ok(MergeSourceKind::RemoteTracking)
    } else {
        Err(GitError::MergeSourceUnsupported)
    }
}

fn dirty_state(git: &git2::Repository, source_ref: &str) -> Result<MergeDirtyState, GitError> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = git
        .statuses(Some(&mut options))
        .map_err(LocalGitBackend::map_git2_error)?;
    let mut staged = BTreeSet::new();
    let mut modified = BTreeSet::new();
    let mut untracked = BTreeSet::new();
    for entry in statuses.iter() {
        let Ok(path) = entry.path() else { continue };
        let status = entry.status();
        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            staged.insert(path.to_string());
        }
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        ) {
            modified.insert(path.to_string());
        }
        if status.contains(git2::Status::WT_NEW) {
            untracked.insert(path.to_string());
        }
    }
    Ok(MergeDirtyState {
        staged: bounded_count(staged.len()),
        modified: bounded_count(modified.len()),
        untracked: bounded_count(untracked.len()),
        would_overwrite: LocalGitBackend::checkout_overwrite_paths_inner(git, source_ref)?,
    })
}

fn reject_hard_blockers(preflight: &MergePreflight) -> Result<(), GitError> {
    for blocker in &preflight.blockers {
        match blocker.as_str() {
            "merge_source_is_current_branch" => return Err(GitError::MergeSourceIsCurrentBranch),
            "merge_source_unsupported" => return Err(GitError::MergeSourceUnsupported),
            "operation_already_in_progress" => return Err(GitError::OperationAlreadyInProgress),
            _ => {}
        }
    }
    Ok(())
}

fn dirty_error(preflight: &MergePreflight) -> GitError {
    if preflight.dirty.staged > 0 {
        GitError::MergeIndexHasStagedChanges
    } else {
        GitError::MergeWouldOverwrite {
            paths: preflight.dirty.would_overwrite.clone(),
        }
    }
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

fn stash_tip(repo: &RepoPath) -> Result<Option<String>, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| match git.find_reference("refs/stash") {
        Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(LocalGitBackend::map_git2_error(error)),
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

fn map_process_error(error: GitRemoteError) -> GitError {
    match error {
        GitRemoteError::Cancelled => GitError::Cancelled,
        GitRemoteError::GitExecutableNotFound => GitError::ExecutableNotFound,
        other => GitError::MergeFailed(other.to_string()),
    }
}

fn bounded_count(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_canonical_branch_refs() {
        assert_eq!(
            classify_source("refs/heads/feature").unwrap(),
            MergeSourceKind::LocalBranch
        );
        assert_eq!(
            classify_source("refs/remotes/origin/feature").unwrap(),
            MergeSourceKind::RemoteTracking
        );
        assert!(matches!(
            classify_source("feature"),
            Err(GitError::MergeSourceUnsupported)
        ));
    }

    #[test]
    fn strips_either_canonical_prefix_for_display() {
        assert_eq!(strip_ref_prefix("refs/heads/feature"), "feature");
        assert_eq!(
            strip_ref_prefix("refs/remotes/origin/feature"),
            "origin/feature"
        );
        assert_eq!(strip_ref_prefix("feature"), "feature");
    }
}
