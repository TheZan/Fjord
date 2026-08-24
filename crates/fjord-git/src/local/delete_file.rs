//! `DestructiveAction::DeleteFile`: path validation, fact computation, and
//! execution. Never recursive (file rows only) and never follows a symlink to
//! its target — the link itself is what gets removed.

use std::path::{Component, Path, PathBuf};

use fjord_domain::{Consequence, Recoverability};
use fjord_ports::{DestructiveActionFacts, GitError, RepoPath};

const BLOCKER_NOT_A_FILE: &str = "delete_target_not_a_file";
const BLOCKER_PARTIALLY_STAGED: &str = "delete_file_partially_staged";
const BLOCKER_CONFLICTED: &str = "delete_file_conflicted";

fn staged_mask() -> git2::Status {
    git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE
}

fn worktree_modified_mask() -> git2::Status {
    git2::Status::WT_MODIFIED
        | git2::Status::WT_DELETED
        | git2::Status::WT_RENAMED
        | git2::Status::WT_TYPECHANGE
}

/// Resolves `path` (repository-relative, forward-slash form as reported by
/// Git) to an absolute filesystem path strictly inside `repo`. `None` means
/// the path cannot be a legitimate deletion target at all: empty, absolute,
/// containing a `..` component, inside `.git`, or resolving outside the
/// repository root.
fn resolve(repo: &RepoPath, path: &str) -> Option<PathBuf> {
    let requested = Path::new(path);
    if path.is_empty() || requested.is_absolute() {
        return None;
    }
    let mut segments = Vec::new();
    for component in requested.components() {
        let Component::Normal(segment) = component else {
            return None;
        };
        if segment.to_string_lossy().eq_ignore_ascii_case(".git") {
            return None;
        }
        segments.push(segment.to_owned());
    }
    if segments.is_empty() {
        return None;
    }
    let canonical_root = std::fs::canonicalize(&repo.0).ok()?;
    let relative: PathBuf = segments.iter().collect();
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = std::fs::canonicalize(canonical_root.join(parent)).ok()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return None;
    }
    let file_name = relative.file_name()?;
    Some(canonical_parent.join(file_name))
}

/// `true` when the resolved path is a real (non-symlink) directory — the one
/// case a file-row action must never touch.
fn is_real_directory(resolved: &Path) -> bool {
    std::fs::symlink_metadata(resolved)
        .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn classify(
    git: &git2::Repository,
    path: &str,
) -> Result<Result<(Vec<Consequence>, Recoverability), &'static str>, GitError> {
    let status = match git.status_file(Path::new(path)) {
        Ok(status) => status,
        Err(_) => return Ok(Err(BLOCKER_NOT_A_FILE)),
    };
    if status.is_conflicted() {
        return Ok(Err(BLOCKER_CONFLICTED));
    }
    if status.intersects(staged_mask()) {
        return Ok(Err(BLOCKER_PARTIALLY_STAGED));
    }
    if status.contains(git2::Status::WT_NEW) {
        return Ok(Ok((
            vec![Consequence::FileRemoved {
                path: path.to_string(),
                tracked: false,
            }],
            Recoverability::NotRecoverable,
        )));
    }
    let modified = status.intersects(worktree_modified_mask());
    let mut consequences = vec![Consequence::FileRemoved {
        path: path.to_string(),
        tracked: true,
    }];
    if modified {
        consequences.push(Consequence::ModifiedFilesDiscarded {
            count: 1,
            sample: vec![path.to_string()],
        });
    }
    let recoverable = if modified {
        Recoverability::NotRecoverable
    } else {
        Recoverability::Committed
    };
    Ok(Ok((consequences, recoverable)))
}

pub(super) fn facts(
    git: &git2::Repository,
    repo: &RepoPath,
    path: &str,
) -> Result<DestructiveActionFacts, GitError> {
    let Some(resolved) = resolve(repo, path) else {
        return Ok(blocked(BLOCKER_NOT_A_FILE));
    };
    if is_real_directory(&resolved) {
        return Ok(blocked(BLOCKER_NOT_A_FILE));
    }
    match classify(git, path)? {
        Ok((consequences, recoverable)) => Ok(DestructiveActionFacts {
            consequences,
            recoverable,
            blockers: Vec::new(),
        }),
        Err(blocker) => Ok(blocked(blocker)),
    }
}

fn blocked(reason: &str) -> DestructiveActionFacts {
    DestructiveActionFacts {
        consequences: Vec::new(),
        recoverable: Recoverability::NotRecoverable,
        blockers: vec![reason.to_string()],
    }
}

fn blocker_error(reason: &str, path: &str) -> GitError {
    match reason {
        BLOCKER_PARTIALLY_STAGED => GitError::DeleteFilePartiallyStaged {
            path: path.to_string(),
        },
        BLOCKER_CONFLICTED => GitError::DeleteFileConflicted {
            path: path.to_string(),
        },
        _ => GitError::DeleteTargetNotAFile,
    }
}

/// Re-validates every blocker under the repository write lock and deletes.
/// Never touches the index: a tracked deletion surfaces as an ordinary
/// unstaged Git deletion, never a staged one.
pub(super) fn execute(git: &git2::Repository, repo: &RepoPath, path: &str) -> Result<(), GitError> {
    let Some(resolved) = resolve(repo, path) else {
        return Err(GitError::DeleteTargetNotAFile);
    };
    if is_real_directory(&resolved) {
        return Err(GitError::DeleteTargetNotAFile);
    }
    if let Err(blocker) = classify(git, path)?.map(|_| ()) {
        return Err(blocker_error(blocker, path));
    }
    remove_file_or_symlink(&resolved).map_err(|error| GitError::Git2(error.to_string()))
}

/// A symlink is unlinked, never followed. On Windows a directory-typed
/// symlink must be removed with `remove_dir` (which only drops the reparse
/// point, not the target's contents) or the OS refuses the call.
fn remove_file_or_symlink(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() && meta.is_dir() {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    }
}
