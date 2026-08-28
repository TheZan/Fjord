//! Working-tree inspection and index staging.

use super::*;
use std::collections::HashSet;
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
                            tracked: true,
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
                            tracked: delta.status() != git2::Delta::Untracked,
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
    whitespace: DiffWhitespaceMode,
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
            apply_whitespace_mode(&mut options, whitespace);
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
                    offset: 0,
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

pub(super) fn apply_whitespace_mode(
    options: &mut git2::DiffOptions,
    whitespace: DiffWhitespaceMode,
) {
    match whitespace {
        DiffWhitespaceMode::Show => {}
        DiffWhitespaceMode::IgnoreTrailing => {
            options.ignore_whitespace_eol(true);
        }
        DiffWhitespaceMode::IgnoreAll => {
            options.ignore_whitespace(true);
        }
    }
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

            if paths.is_empty() {
                // Empty remains the deliberate Stage All contract.
                index
                    .add_all(["*"], IndexAddOption::DEFAULT, None)
                    .map_err(LocalGitBackend::map_git2_error)?;
            } else {
                // `add_all` treats semantic filenames as pathspecs. Use
                // literal index operations against one fresh index and write
                // it once; missing tracked paths represent deletions.
                for path in &paths {
                    match index.add_path(path) {
                        Ok(()) => {}
                        Err(error) if error.code() == git2::ErrorCode::NotFound => {
                            // `add_path` is literal but cannot represent a
                            // deletion. Remove the missing tracked path from
                            // this same in-memory index transaction instead.
                            if index.get_path(path, 0).is_some() {
                                index
                                    .remove_path(path)
                                    .map_err(LocalGitBackend::map_git2_error)?;
                            }
                        }
                        Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
                    }
                }
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
    selections: &[PatchSelection],
    generations: crate::GenerationSet,
) -> Result<String, GitError> {
    let confirmations = confirmations.clone();
    let repo = repo.clone();
    let action = action.clone();
    let selections = selections.to_vec();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        ensure_confirmed_generations(&repo, generations)?;
        build_discard_patch(&repo, &action, &selections)?;
        ensure_confirmed_generations(&repo, generations)?;
        confirmations.issue(&repo, &action, &selections, generations)
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
    discard_patches(
        commands,
        confirmations,
        repo,
        action,
        std::slice::from_ref(selection),
        expected_generations,
        confirmation_token,
    )
    .await
}

/// Discards an exact ordered vector of whole-file index-to-worktree
/// selections in one confirmation-bound Git apply transaction. The vector is
/// kept in user-confirmed order for token validation; patch sections are
/// canonicalized by repository-path bytes only after that validation.
pub(super) async fn discard_patches(
    commands: &GitCommandFactory,
    confirmations: &std::sync::Arc<destructive_confirmation::DestructiveConfirmationStore>,
    repo: &RepoPath,
    action: &DestructiveAction,
    selections: &[PatchSelection],
    expected_generations: crate::GenerationSet,
    confirmation_token: &str,
) -> Result<crate::GenerationSet, GitError> {
    let commands = commands.clone();
    let confirmations = confirmations.clone();
    let repo = repo.clone();
    let action = action.clone();
    let selections = selections.to_vec();
    let confirmation_token = confirmation_token.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        confirmations.consume(
            &confirmation_token,
            &repo,
            &action,
            &selections,
            expected_generations,
        )?;
        let index_lock = patch_transaction::IndexLock::acquire(&repo)?;
        ensure_confirmed_generations(&repo, expected_generations)?;

        let patch = build_discard_patch(&repo, &action, &selections)?;
        ensure_confirmed_generations(&repo, expected_generations)?;

        run_git_apply_to_worktree(&commands, &repo, &patch, true)?;

        // The standard index lock remains held through this final validation
        // and the worktree mutation, so an external `git add`, commit, reset,
        // checkout, or switch cannot change the discard base in between.
        patch_transaction::pause_before_mutation(&repo);
        ensure_confirmed_generations(&repo, expected_generations)?;
        let verified_patch = build_discard_patch(&repo, &action, &selections)?;
        if verified_patch != patch {
            return Err(GitError::PatchStale);
        }
        index_lock.verify_unchanged()?;

        run_git_apply_to_worktree(&commands, &repo, &patch, false)?;
        runtime::bump_mutation(&repo, MutationKind::Discard);
        runtime::generations(&repo)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

/// Constructs one combined patch for an exact, non-empty, source-homogeneous
/// selection vector without
/// mutating anything: read-only, no index lock, no `git apply`. Reuses the
/// same `P8-01` deterministic constructor and digest verification as every
/// mutating patch command — a stale selection fails with `PatchStale`
/// exactly as it would for staging.
pub(super) async fn export_patch(
    repo: &RepoPath,
    selections: &[PatchSelection],
) -> Result<Vec<u8>, GitError> {
    let repo = repo.clone();
    let selections = selections.to_vec();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || build_export_patch(&repo, &selections))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

fn build_export_patch(repo: &RepoPath, selections: &[PatchSelection]) -> Result<Vec<u8>, GitError> {
    validate_patch_selection_vector(selections)?;
    let staged = selections[0].source == PatchSource::Index;
    let mut sections = Vec::with_capacity(selections.len());
    for selection in selections {
        let detail = current_index_patch_diff(repo, &selection.path, staged)?;
        let bytes = patch::build_unified_patch(&detail, selection)?;
        sections.push((selection.path.as_bytes().to_vec(), bytes));
    }
    Ok(concatenate_patch_sections(sections))
}

fn build_discard_patch(
    repo: &RepoPath,
    action: &DestructiveAction,
    selections: &[PatchSelection],
) -> Result<Vec<u8>, GitError> {
    if selections.is_empty() {
        return Err(GitError::PatchUnsupported(
            "discard selection list must not be empty".to_string(),
        ));
    }

    match action {
        DestructiveAction::Discard { .. } if selections.len() == 1 => {}
        DestructiveAction::DiscardFiles { paths } => {
            if paths.is_empty()
                || paths.len() != selections.len()
                || paths
                    .iter()
                    .zip(selections)
                    .any(|(path, selection)| path != &selection.path)
            {
                return Err(GitError::PreflightStale);
            }
        }
        _ => return Err(GitError::PreflightStale),
    }

    let mut unique = HashSet::with_capacity(selections.len());
    if selections.iter().any(|selection| {
        selection.source != PatchSource::Worktree || !unique.insert(selection.path.as_str())
    }) {
        return Err(GitError::PatchUnsupported(
            "discard requires unique worktree selections".to_string(),
        ));
    }

    ensure_no_conflicted_paths(
        repo,
        selections.iter().map(|selection| selection.path.as_str()),
    )?;

    let batch = matches!(action, DestructiveAction::DiscardFiles { .. });
    let mut sections = Vec::with_capacity(selections.len());
    for selection in selections {
        let detail = current_index_patch_diff(repo, &selection.path, false)?;
        if batch {
            ensure_whole_file_selection(selection, &detail)?;
        } else {
            ensure_discard_scope_matches(action, selection, &detail)?;
        }
        let bytes = patch::build_unified_reverse_patch(&detail, selection)?;
        sections.push((selection.path.as_bytes().to_vec(), bytes));
    }
    Ok(concatenate_patch_sections(sections))
}

fn validate_patch_selection_vector(selections: &[PatchSelection]) -> Result<(), GitError> {
    let Some(first) = selections.first() else {
        return Err(GitError::PatchUnsupported(
            "patch selection list must not be empty".to_string(),
        ));
    };
    let mut unique = HashSet::with_capacity(selections.len());
    if selections.iter().any(|selection| {
        selection.source != first.source || !unique.insert(selection.path.as_str())
    }) {
        return Err(GitError::PatchUnsupported(
            "patch selections must have one source and unique paths".to_string(),
        ));
    }
    Ok(())
}

fn concatenate_patch_sections(mut sections: Vec<(Vec<u8>, Vec<u8>)>) -> Vec<u8> {
    sections.sort_by(|left, right| left.0.cmp(&right.0));
    let capacity = sections.iter().map(|(_, bytes)| bytes.len()).sum();
    let mut combined = Vec::with_capacity(capacity);
    for (_, bytes) in sections {
        combined.extend_from_slice(&bytes);
    }
    combined
}

fn ensure_no_conflicted_paths<'a>(
    repo: &RepoPath,
    paths: impl Iterator<Item = &'a str>,
) -> Result<(), GitError> {
    let selected = paths.collect::<HashSet<_>>();
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let conflicts = LocalGitBackend::conflict_paths(&LocalGitBackend::fresh_index(git)?)
            .into_iter()
            .filter(|path| selected.contains(path.as_str()))
            .collect::<Vec<_>>();
        if conflicts.is_empty() {
            Ok(())
        } else {
            Err(GitError::Conflict { paths: conflicts })
        }
    })
}

fn ensure_whole_file_selection(
    selection: &PatchSelection,
    detail: &FileDiffDetail,
) -> Result<(), GitError> {
    if selection.path == detail.path && is_complete_file_selection(detail, selection)? {
        Ok(())
    } else {
        Err(GitError::PreflightStale)
    }
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
        _ => false,
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
        _ => None,
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

        // Acquiring the real index lock is the external-process transaction
        // boundary. Stage/unstage build their result in that lock file and only
        // publish it after every defining state has been revalidated.
        let transaction = patch_transaction::IndexTransaction::begin(&commands, &repo)?;
        let _head_lock = if matches!(operation, IndexPatchOperation::Unstage) {
            Some(patch_transaction::HeadLock::acquire(&commands, &repo)?)
        } else {
            None
        };
        ensure_expected_generations(&repo, expected_generations)?;

        let detail = current_index_patch_diff(&repo, &selection.path, operation.staged())?;
        let patch = build_index_patch(&detail, &selection, operation)?;
        ensure_expected_generations(&repo, expected_generations)?;

        run_git_apply_to_transaction_index(
            &commands,
            &repo,
            transaction.alternate_index_path(),
            &patch,
            true,
            operation.reverse(),
        )?;
        run_git_apply_to_transaction_index(
            &commands,
            &repo,
            transaction.alternate_index_path(),
            &patch,
            false,
            operation.reverse(),
        )?;

        patch_transaction::pause_before_mutation(&repo);
        ensure_expected_generations(&repo, expected_generations)?;
        let verified_detail = current_index_patch_diff(&repo, &selection.path, operation.staged())?;
        let verified_patch = build_index_patch(&verified_detail, &selection, operation)?;
        if verified_patch != patch {
            return Err(GitError::PatchStale);
        }
        transaction.verify_original_unchanged()?;

        transaction.commit()?;
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
    if matches!(operation, IndexPatchOperation::Unstage)
        && detail.change_type == FileChangeType::Deleted
        && !is_complete_file_selection(detail, selection)?
    {
        return Err(GitError::PatchUnsupported(
            "partial unstage of a deleted file has no safe representation".to_string(),
        ));
    }
    if operation.reverse() {
        patch::build_unified_reverse_patch(detail, selection)
    } else {
        patch::build_unified_patch(detail, selection)
    }
}

fn is_complete_file_selection(
    detail: &FileDiffDetail,
    selection: &PatchSelection,
) -> Result<bool, GitError> {
    if selection.hunks.len() != detail.hunks.len() {
        return Ok(false);
    }

    for hunk in &detail.hunks {
        let Some(selected) = selection
            .hunks
            .iter()
            .find(|selected| hunk_coordinates_match(selected, hunk))
        else {
            return Ok(false);
        };
        if !selected.lines.is_empty() {
            return Ok(false);
        }
    }

    Ok(true)
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

#[cfg(test)]
pub(super) fn run_git_apply_to_index(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    patch: &[u8],
    check: bool,
    reverse: bool,
) -> Result<(), GitError> {
    run_git_apply(
        commands,
        repo,
        patch,
        check,
        GitApplyTarget::Index { reverse },
        None,
    )
}

fn run_git_apply_to_transaction_index(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    alternate_index: &std::path::Path,
    patch: &[u8],
    check: bool,
    reverse: bool,
) -> Result<(), GitError> {
    run_git_apply(
        commands,
        repo,
        patch,
        check,
        GitApplyTarget::Index { reverse },
        Some(alternate_index),
    )
}

pub(super) fn run_git_apply_to_worktree(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    patch: &[u8],
    check: bool,
) -> Result<(), GitError> {
    run_git_apply(
        commands,
        repo,
        patch,
        check,
        GitApplyTarget::WorktreeReverse,
        None,
    )
}

/// The only Phase 8 `git apply` profile. It deliberately overrides the two
/// apply-specific configuration keys that otherwise change whether Git rewrites
/// whitespace or relaxes context matching. `nowarn` accepts the validated patch
/// bytes without stripping/fixing whitespace; disabling whitespace matching keeps
/// applicability exact to the patch Fjord constructed.
enum GitApplyTarget {
    Index { reverse: bool },
    WorktreeReverse,
}

fn run_git_apply(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    patch: &[u8],
    check: bool,
    target: GitApplyTarget,
    alternate_index: Option<&std::path::Path>,
) -> Result<(), GitError> {
    let mut command = commands.command()?;
    command
        .arg("apply")
        .arg("--whitespace=nowarn")
        .arg("--no-ignore-whitespace");
    if check {
        command.arg("--check");
    }

    let target_description = match target {
        GitApplyTarget::Index { reverse } => {
            if reverse {
                command.arg("--reverse");
            }
            command.arg("--cached");
            "index"
        }
        GitApplyTarget::WorktreeReverse => {
            command.arg("--reverse");
            "worktree"
        }
    };
    command
        .current_dir(&repo.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(alternate_index) = alternate_index {
        command.env("GIT_INDEX_FILE", alternate_index);
    }

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
        Err(GitError::PatchApplyFailed(format!(
            "Git could not apply the selected patch to the {target_description}"
        )))
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
                let mut index = LocalGitBackend::fresh_index(git)?;
                let mut head_index = git2::Index::new().map_err(LocalGitBackend::map_git2_error)?;
                if let Some(head) = head.as_ref() {
                    let tree = head
                        .peel_to_tree()
                        .map_err(LocalGitBackend::map_git2_error)?;
                    head_index
                        .read_tree(&tree)
                        .map_err(LocalGitBackend::map_git2_error)?;
                }

                for path in &paths {
                    if let Some(head_entry) = head_index.get_path(path, 0) {
                        index
                            .add(&head_entry)
                            .map_err(LocalGitBackend::map_git2_error)?;
                    } else if index.get_path(path, 0).is_some() {
                        index
                            .remove_path(path)
                            .map_err(LocalGitBackend::map_git2_error)?;
                    }
                }
                index.write().map_err(LocalGitBackend::map_git2_error)
            }
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}
