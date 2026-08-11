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
    apply_index_patch(
        commands,
        repo,
        selection,
        expected_generations,
        IndexPatchOperation::Stage,
    )
    .await
}

/// Unstages one verified index selection without touching the working tree.
pub(super) async fn unstage_patch(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: crate::GenerationSet,
) -> Result<crate::GenerationSet, GitError> {
    apply_index_patch(
        commands,
        repo,
        selection,
        expected_generations,
        IndexPatchOperation::Unstage,
    )
    .await
}

/// Discards one verified index-to-worktree selection. The current index is the
/// patch base; neither HEAD nor the index is written by this operation.
pub(super) async fn issue_discard_confirmation(
    confirmations: &std::sync::Arc<destructive_confirmation::DestructiveConfirmationStore>,
    repo: &RepoPath,
    action: &DestructiveAction,
    selection: &PatchSelection,
    generations: crate::GenerationSet,
) -> Result<String, GitError> {
    let confirmations = confirmations.clone();
    let repo = repo.clone();
    let action = action.clone();
    let selection = selection.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        ensure_confirmed_generations(&repo, generations)?;
        let detail = current_index_patch_diff(&repo, &selection.path, false)?;
        ensure_discard_scope_matches(&action, &selection, &detail)?;
        patch::build_unified_reverse_patch(&detail, &selection)?;
        ensure_confirmed_generations(&repo, generations)?;
        confirmations.issue(&repo, &action, &selection, generations)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn discard_patch(
    commands: &GitCommandFactory,
    confirmations: &std::sync::Arc<destructive_confirmation::DestructiveConfirmationStore>,
    repo: &RepoPath,
    action: &DestructiveAction,
    selection: &PatchSelection,
    expected_generations: crate::GenerationSet,
    confirmation_token: &str,
) -> Result<crate::GenerationSet, GitError> {
    let commands = commands.clone();
    let confirmations = confirmations.clone();
    let repo = repo.clone();
    let action = action.clone();
    let selection = selection.clone();
    let confirmation_token = confirmation_token.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        confirmations.consume(
            &confirmation_token,
            &repo,
            &action,
            &selection,
            expected_generations,
        )?;
        if selection.source != PatchSource::Worktree {
            return Err(GitError::PatchUnsupported(
                "discard_patch requires a worktree selection".to_string(),
            ));
        }
        ensure_confirmed_generations(&repo, expected_generations)?;

        let detail = current_index_patch_diff(&repo, &selection.path, false)?;
        let patch = patch::build_unified_reverse_patch(&detail, &selection)?;
        ensure_confirmed_generations(&repo, expected_generations)?;

        run_git_apply_to_worktree(&commands, &repo, &patch, true)?;

        // A successful check is not authority to mutate later. Re-read and
        // reconstruct while still holding the write lock so an out-of-band
        // edit can only fail closed as stale or at Git's atomic apply step.
        ensure_confirmed_generations(&repo, expected_generations)?;
        let verified_detail = current_index_patch_diff(&repo, &selection.path, false)?;
        let verified_patch = patch::build_unified_reverse_patch(&verified_detail, &selection)?;
        if verified_patch != patch {
            return Err(GitError::PatchStale);
        }

        run_git_apply_to_worktree(&commands, &repo, &patch, false)?;
        runtime::bump_mutation(&repo, MutationKind::Discard);
        runtime::generations(&repo)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn ensure_discard_scope_matches(
    action: &DestructiveAction,
    selection: &PatchSelection,
    detail: &FileDiffDetail,
) -> Result<(), GitError> {
    if selection.source != PatchSource::Worktree
        || selection.path != detail.path
        || action_discard_path(action) != Some(selection.path.as_str())
    {
        return Err(GitError::PreflightStale);
    }

    let matches = match action {
        DestructiveAction::Discard {
            selection: DiscardSelection::File { .. },
        } => {
            selection.hunks.len() == detail.hunks.len()
                && selection
                    .hunks
                    .iter()
                    .zip(&detail.hunks)
                    .all(|(selected, current)| {
                        selected.lines.is_empty() && hunk_coordinates_match(selected, current)
                    })
        }
        DestructiveAction::Discard {
            selection:
                DiscardSelection::Hunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    ..
                },
        } => {
            selection.hunks.as_slice()
                == [HunkSelection {
                    old_start: *old_start,
                    old_lines: *old_lines,
                    new_start: *new_start,
                    new_lines: *new_lines,
                    lines: Vec::new(),
                }]
        }
        DestructiveAction::Discard {
            selection:
                DiscardSelection::Lines {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines,
                    ..
                },
        } => {
            selection.hunks.as_slice()
                == [HunkSelection {
                    old_start: *old_start,
                    old_lines: *old_lines,
                    new_start: *new_start,
                    new_lines: *new_lines,
                    lines: lines.clone(),
                }]
        }
        DestructiveAction::ForceWithLease { .. } => false,
    };

    if matches {
        Ok(())
    } else {
        Err(GitError::PreflightStale)
    }
}

fn action_discard_path(action: &DestructiveAction) -> Option<&str> {
    match action {
        DestructiveAction::Discard { selection } => Some(selection.path()),
        DestructiveAction::ForceWithLease { .. } => None,
    }
}

fn hunk_coordinates_match(selection: &HunkSelection, hunk: &DiffHunk) -> bool {
    selection.old_start == hunk.old_start
        && selection.old_lines == hunk.old_lines
        && selection.new_start == hunk.new_start
        && selection.new_lines == hunk.new_lines
}

#[derive(Clone, Copy)]
enum IndexPatchOperation {
    Stage,
    Unstage,
}

impl IndexPatchOperation {
    const fn source(self) -> PatchSource {
        match self {
            Self::Stage => PatchSource::Worktree,
            Self::Unstage => PatchSource::Index,
        }
    }

    const fn staged(self) -> bool {
        matches!(self, Self::Unstage)
    }

    const fn reverse(self) -> bool {
        matches!(self, Self::Unstage)
    }

    const fn mutation(self) -> MutationKind {
        match self {
            Self::Stage => MutationKind::Stage,
            Self::Unstage => MutationKind::Unstage,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Stage => "stage_patch",
            Self::Unstage => "unstage_patch",
        }
    }
}

async fn apply_index_patch(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: crate::GenerationSet,
    operation: IndexPatchOperation,
) -> Result<crate::GenerationSet, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let selection = selection.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if selection.source != operation.source() {
            return Err(GitError::PatchUnsupported(format!(
                "{} requires a {} selection",
                operation.name(),
                match operation.source() {
                    PatchSource::Worktree => "worktree",
                    PatchSource::Index => "index",
                }
            )));
        }
        ensure_expected_generations(&repo, expected_generations)?;

        let detail = current_index_patch_diff(&repo, &selection.path, operation.staged())?;
        let patch = build_index_patch(&detail, &selection, operation)?;
        ensure_expected_generations(&repo, expected_generations)?;

        run_git_apply_to_index(&commands, &repo, &patch, true, operation.reverse())?;

        // `--check` is intentionally followed by a fresh diff reconstruction.
        // This closes the ordinary out-of-band-change window without trusting
        // the earlier bytes merely because Git considered them applicable.
        ensure_expected_generations(&repo, expected_generations)?;
        let verified_detail = current_index_patch_diff(&repo, &selection.path, operation.staged())?;
        let verified_patch = build_index_patch(&verified_detail, &selection, operation)?;
        if verified_patch != patch {
            return Err(GitError::PatchStale);
        }

        run_git_apply_to_index(&commands, &repo, &patch, false, operation.reverse())?;
        runtime::bump_mutation(&repo, operation.mutation());
        runtime::generations(&repo)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn build_index_patch(
    detail: &FileDiffDetail,
    selection: &PatchSelection,
    operation: IndexPatchOperation,
) -> Result<Vec<u8>, GitError> {
    if operation.reverse() {
        patch::build_unified_reverse_patch(detail, selection)
    } else {
        patch::build_unified_patch(detail, selection)
    }
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

fn ensure_confirmed_generations(
    repo: &RepoPath,
    expected: crate::GenerationSet,
) -> Result<(), GitError> {
    if runtime::generations(repo)? == expected {
        Ok(())
    } else {
        Err(GitError::PreflightStale)
    }
}

fn current_index_patch_diff(
    repo: &RepoPath,
    path: &str,
    staged: bool,
) -> Result<FileDiffDetail, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let mut options = git2::DiffOptions::new();
        options
            .pathspec(path)
            .disable_pathspec_match(true)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        let index = LocalGitBackend::fresh_index(git)?;
        let diff = if staged {
            let head_tree = LocalGitBackend::current_head_commit(git)?
                .map(|commit| commit.tree())
                .transpose()
                .map_err(LocalGitBackend::map_git2_error)?;
            git.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut options))
                .map_err(LocalGitBackend::map_git2_error)?
        } else {
            git.diff_index_to_workdir(Some(&index), Some(&mut options))
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
    reverse: bool,
) -> Result<(), GitError> {
    let mut command = commands.command()?;
    command.arg("apply");
    if check {
        command.arg("--check");
    }
    if reverse {
        command.arg("--reverse");
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

pub(super) fn run_git_apply_to_worktree(
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
        .arg("--reverse")
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
            "Git could not apply the selected patch to the worktree".to_string(),
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
