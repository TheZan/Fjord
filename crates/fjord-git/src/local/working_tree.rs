//! Working-tree inspection and index staging.

use super::*;

pub(super) async fn working_changes(repo: &RepoPath) -> Result<WorkingChanges, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut options = git2::StatusOptions::new();
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true);

            let statuses = git
                .statuses(Some(&mut options))
                .map_err(LocalGitBackend::map_git2_error)?;
            let mut out = WorkingChanges::default();

            for entry in statuses.iter() {
                let status = entry.status();
                let conflicted = status.is_conflicted();

                if let Some(delta) = entry.head_to_index() {
                    let path = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .map(|p| p.to_string_lossy().into_owned());
                    if let Some(path) = path {
                        out.staged.push(WorkingFile {
                            path,
                            change_type: LocalGitBackend::classify_delta(delta.status()),
                            conflicted,
                        });
                    }
                }

                if let Some(delta) = entry.index_to_workdir() {
                    let path = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .map(|p| p.to_string_lossy().into_owned());
                    if let Some(path) = path {
                        out.unstaged.push(WorkingFile {
                            path,
                            change_type: LocalGitBackend::classify_delta(delta.status()),
                            conflicted,
                        });
                    }
                }
            }

            Ok(out)
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn working_file_diff(
    repo: &RepoPath,
    path: &str,
    staged: bool,
) -> Result<FileDiffDetail, GitError> {
    let repo = repo.clone();
    let path = path.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut options = git2::DiffOptions::new();
            options
                .pathspec(&path)
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);

            let diff = if staged {
                let head_tree = LocalGitBackend::current_head_commit(git)?
                    .map(|commit| commit.tree())
                    .transpose()
                    .map_err(LocalGitBackend::map_git2_error)?;
                git.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))
                    .map_err(LocalGitBackend::map_git2_error)?
            } else {
                git.diff_index_to_workdir(None, Some(&mut options))
                    .map_err(LocalGitBackend::map_git2_error)?
            };

            let change_type = diff
                .deltas()
                .next()
                .map(|delta| LocalGitBackend::classify_delta(delta.status()))
                .unwrap_or(FileChangeType::Modified);
            let (is_binary, hunks) = LocalGitBackend::collect_git2_diff(&diff)?;

            Ok(FileDiffDetail {
                path,
                change_type,
                is_binary,
                hunks,
            })
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn working_file_diff_window(
    repo: &RepoPath,
    path: &str,
    staged: bool,
    offset: u32,
    limit: u32,
    max_file_bytes: u64,
) -> Result<FileDiffWindow, GitError> {
    let repo = repo.clone();
    let path = path.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut options = git2::DiffOptions::new();
            options
                .pathspec(&path)
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            let diff = if staged {
                let head_tree = LocalGitBackend::current_head_commit(git)?
                    .map(|commit| commit.tree())
                    .transpose()
                    .map_err(LocalGitBackend::map_git2_error)?;
                git.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))
                    .map_err(LocalGitBackend::map_git2_error)?
            } else {
                git.diff_index_to_workdir(None, Some(&mut options))
                    .map_err(LocalGitBackend::map_git2_error)?
            };
            let delta = diff.deltas().next();
            let change_type = delta
                .as_ref()
                .map(|delta| LocalGitBackend::classify_delta(delta.status()))
                .unwrap_or(FileChangeType::Modified);
            let file_bytes = delta
                .as_ref()
                .map(|delta| delta.old_file().size().max(delta.new_file().size()))
                .unwrap_or(0);
            if file_bytes > max_file_bytes {
                return Ok(FileDiffWindow {
                    path,
                    change_type,
                    is_binary: false,
                    too_large: true,
                    file_bytes,
                    hunks: Vec::new(),
                    total_hunks: 0,
                    total_lines: 0,
                    truncated: false,
                    next_offset: None,
                });
            }
            let (is_binary, hunks) = LocalGitBackend::collect_git2_diff(&diff)?;
            let mut window = FileDiffDetail {
                path,
                change_type,
                is_binary,
                hunks,
            }
            .into_window(offset, limit);
            window.file_bytes = file_bytes;
            Ok(window)
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn stage(repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
    let repo = repo.clone();
    let paths = paths.to_vec();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut index = LocalGitBackend::fresh_index(git)?;

            // `add_all` rather than `add_path` even for explicit paths: it is
            // the only one that also records *deletions*, so staging a removed
            // file from the commit panel doesn't fail on the missing file.
            if paths.is_empty() {
                index
                    .add_all(["*"], IndexAddOption::DEFAULT, None)
                    .map_err(LocalGitBackend::map_git2_error)?;
            } else {
                index
                    .add_all(paths.iter(), IndexAddOption::DEFAULT, None)
                    .map_err(LocalGitBackend::map_git2_error)?;
            }

            index.write().map_err(LocalGitBackend::map_git2_error)
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn unstage(repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
    let repo = repo.clone();
    let paths = paths.to_vec();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let head = git
                .head()
                .ok()
                .and_then(|head| head.peel(git2::ObjectType::Commit).ok());

            if paths.is_empty() {
                git.reset_default(head.as_ref(), ["*"])
                    .map_err(LocalGitBackend::map_git2_error)
            } else {
                git.reset_default(head.as_ref(), paths.iter())
                    .map_err(LocalGitBackend::map_git2_error)
            }
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}
