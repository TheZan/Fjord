//! Working-tree inspection and index staging.

use super::*;
use std::io::Write;

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
                .disable_pathspec_match(true)
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
            let old_mode = delta
                .as_ref()
                .and_then(|delta| file_mode(delta.old_file().mode()));
            let new_mode = delta
                .as_ref()
                .and_then(|delta| file_mode(delta.new_file().mode()));
            let (is_binary, hunks) = LocalGitBackend::collect_git2_diff(&diff)?;

            Ok(FileDiffDetail {
                path,
                change_type,
                old_mode,
                new_mode,
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
                .disable_pathspec_match(true)
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
                    old_mode: delta
                        .as_ref()
                        .and_then(|delta| file_mode(delta.old_file().mode())),
                    new_mode: delta
                        .as_ref()
                        .and_then(|delta| file_mode(delta.new_file().mode())),
                    is_binary: false,
                    too_large: true,
                    file_bytes,
                    hunks: Vec::new(),
                    total_hunks: 0,
                    total_lines: 0,
                    truncated: false,
                    next_offset: None,
                    base_digest: None,
                });
            }
            let (is_binary, hunks) = LocalGitBackend::collect_git2_diff(&diff)?;
            let detail = FileDiffDetail {
                path,
                change_type,
                old_mode: delta
                    .as_ref()
                    .and_then(|delta| file_mode(delta.old_file().mode())),
                new_mode: delta
                    .as_ref()
                    .and_then(|delta| file_mode(delta.new_file().mode())),
                is_binary,
                hunks,
            };
            let source = if staged {
                PatchSource::Index
            } else {
                PatchSource::Worktree
            };
            let base_digest = patch::base_digest(&detail, source);
            let mut window = detail.into_window(offset, limit);
            window.file_bytes = file_bytes;
            window.base_digest = Some(base_digest);
            Ok(window)
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

fn file_mode(mode: git2::FileMode) -> Option<u32> {
    match mode {
        git2::FileMode::Unreadable => None,
        mode => Some(u32::from(mode)),
    }
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

/// Stages one verified worktree selection while keeping state validation,
/// application, and the generation bump inside the repository write lock.
pub(super) async fn stage_patch(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: crate::GenerationSet,
) -> Result<crate::GenerationSet, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let selection = selection.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if selection.source != PatchSource::Worktree {
            return Err(GitError::PatchUnsupported(
                "stage_patch requires a worktree selection".to_string(),
            ));
        }
        ensure_expected_generations(&repo, expected_generations)?;

        let detail = current_worktree_diff(&repo, &selection.path)?;
        let patch = patch::build_unified_patch(&detail, &selection)?;
        ensure_expected_generations(&repo, expected_generations)?;

        run_git_apply_to_index(&commands, &repo, &patch, true)?;

        // `--check` is intentionally followed by a fresh diff reconstruction.
        // This closes the ordinary out-of-band-change window without trusting
        // the earlier bytes merely because Git considered them applicable.
        ensure_expected_generations(&repo, expected_generations)?;
        let verified_detail = current_worktree_diff(&repo, &selection.path)?;
        let verified_patch = patch::build_unified_patch(&verified_detail, &selection)?;
        if verified_patch != patch {
            return Err(GitError::PatchStale);
        }

        run_git_apply_to_index(&commands, &repo, &patch, false)?;
        runtime::bump_mutation(&repo, MutationKind::Stage);
        runtime::generations(&repo)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn ensure_expected_generations(
    repo: &RepoPath,
    expected: crate::GenerationSet,
) -> Result<(), GitError> {
    if runtime::generations(repo)? == expected {
        Ok(())
    } else {
        Err(GitError::PatchStale)
    }
}

fn current_worktree_diff(repo: &RepoPath, path: &str) -> Result<FileDiffDetail, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let mut options = git2::DiffOptions::new();
        options
            .pathspec(path)
            .disable_pathspec_match(true)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        let index = LocalGitBackend::fresh_index(git)?;
        let diff = git
            .diff_index_to_workdir(Some(&index), Some(&mut options))
            .map_err(LocalGitBackend::map_git2_error)?;
        let delta = diff.deltas().next();
        let change_type = delta
            .as_ref()
            .map(|delta| LocalGitBackend::classify_delta(delta.status()))
            .unwrap_or(FileChangeType::Modified);
        let old_mode = delta
            .as_ref()
            .and_then(|delta| file_mode(delta.old_file().mode()));
        let new_mode = delta
            .as_ref()
            .and_then(|delta| file_mode(delta.new_file().mode()));
        let (is_binary, hunks) = LocalGitBackend::collect_git2_diff(&diff)?;
        Ok(FileDiffDetail {
            path: path.to_string(),
            change_type,
            old_mode,
            new_mode,
            is_binary,
            hunks,
        })
    })
}

pub(super) fn run_git_apply_to_index(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    patch: &[u8],
    check: bool,
) -> Result<(), GitError> {
    let mut command = commands.command()?;
    command.arg("apply");
    if check {
        command.arg("--check");
    }
    command
        .arg("--cached")
        .current_dir(&repo.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command.spawn().map_err(|_| {
        GitError::PatchApplyFailed("could not start Git patch application".to_string())
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| GitError::PatchApplyFailed("Git patch input was unavailable".to_string()))?;
    let write_result = stdin.write_all(patch);
    drop(stdin);
    if write_result.is_err() {
        let _ = child.wait();
        return Err(GitError::PatchApplyFailed(
            "could not send the selected patch to Git".to_string(),
        ));
    }

    let status = child.wait().map_err(|_| {
        GitError::PatchApplyFailed("could not await Git patch application".to_string())
    })?;
    if status.success() {
        Ok(())
    } else if check {
        Err(GitError::PatchApplyFailed(
            "Git rejected the selected patch during validation".to_string(),
        ))
    } else {
        Err(GitError::PatchApplyFailed(
            "Git could not apply the selected patch to the index".to_string(),
        ))
    }
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
