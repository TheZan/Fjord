//! Shared integration facts and explicit stash primitive (branch-merge section 4).
//! Legacy merge type/code names are retained for IPC compatibility.
use super::operation_state::OperationOriginTracker;
use super::*;
use crate::executable::GitCommandFactory;
use crate::remote::process_runner::GitProcessRunner;
use fjord_domain::{
    CommitId, MergeDirtyState, MergePrediction, MergePreflight, MergeSource, MergeSourceKind,
    RepoOperation,
};
use fjord_ports::{GitError, RepoPath};
use std::collections::BTreeSet;
pub(super) fn preflight_locked(
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
            if !matches!(
                state.operation,
                RepoOperation::Normal
                    | RepoOperation::Detached { .. }
                    | RepoOperation::UnbornBranch
            ) {
                return Err(GitError::OperationAlreadyInProgress);
            }
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

pub(super) fn dirty_state(
    git: &git2::Repository,
    source_ref: &str,
) -> Result<MergeDirtyState, GitError> {
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

pub(super) fn reject_hard_blockers(preflight: &MergePreflight) -> Result<(), GitError> {
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

pub(super) fn dirty_error(preflight: &MergePreflight) -> GitError {
    if preflight.dirty.staged > 0 {
        GitError::MergeIndexHasStagedChanges
    } else {
        GitError::MergeWouldOverwrite {
            paths: preflight.dirty.would_overwrite.clone(),
        }
    }
}

pub(super) async fn stash(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    message: String,
    context: fjord_ports::GitOperationContext,
) -> (bool, Result<(), GitError>) {
    let before = match stash_tip(repo) {
        Ok(value) => value,
        Err(error) => return (false, Err(error)),
    };
    let spec = commands.executable().map(|executable| {
        super::operation_control::command_spec(
            executable,
            repo,
            vec![
                "stash".into(),
                "push".into(),
                "--include-untracked".into(),
                "--message".into(),
                message.into(),
            ],
        )
    });
    let result = match spec {
        Ok(spec) => GitProcessRunner
            .run(&spec, context, None)
            .await
            .map_err(super::operation_control::map_process_error)
            .and_then(|result| {
                if result.exit_code == Some(0) {
                    Ok(())
                } else {
                    Err(GitError::OperationStepFailed(
                        "Could not stash local changes".into(),
                    ))
                }
            }),
        Err(error) => Err(error),
    };
    match stash_tip(repo) {
        Ok(after) => {
            let created = after != before;
            let result = result.and_then(|()| {
                if created {
                    Ok(())
                } else {
                    Err(GitError::OperationStepFailed(
                        "Git did not create the requested stash".into(),
                    ))
                }
            });
            (created, result)
        }
        Err(error) => (false, Err(error)),
    }
}

pub(super) fn stash_tip(repo: &RepoPath) -> Result<Option<String>, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| match git.find_reference("refs/stash") {
        Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(LocalGitBackend::map_git2_error(error)),
    })
}

/// Resolve the actual reflog selector; retain the immutable stash id as fallback.
pub(super) fn stash_ref(repo: &RepoPath, oid: &str) -> String {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let log = git
            .reflog("refs/stash")
            .map_err(LocalGitBackend::map_git2_error)?;
        Ok(log
            .iter()
            .position(|entry| entry.id_new().to_string() == oid)
            .map(|index| format!("stash@{{{index}}}"))
            .unwrap_or_else(|| oid.to_string()))
    })
    .unwrap_or_else(|_| oid.to_string())
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
