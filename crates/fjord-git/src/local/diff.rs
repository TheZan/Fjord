//! Committed and single-file diffs, including line statistics.

use super::*;

impl LocalGitBackend {
    /// The commit's tree and its first parent's tree (`None` for a root commit), which
    /// together define the changeset shown for that commit — see docs/specs/git-backend.md.
    pub(super) fn commit_trees<'r>(
        git: &'r gix::Repository,
        commit_id: &str,
    ) -> Result<(Option<gix::Tree<'r>>, gix::Tree<'r>), GitError> {
        let oid = gix::ObjectId::from_hex(commit_id.as_bytes())
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let commit = git
            .find_object(oid)
            .map_err(|e| GitError::Gix(e.to_string()))?
            .try_into_commit()
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let new_tree = commit.tree().map_err(|e| GitError::Gix(e.to_string()))?;

        let old_tree = match commit.parent_ids().next() {
            Some(parent_id) => {
                let parent = parent_id
                    .object()
                    .map_err(|e| GitError::Gix(e.to_string()))?
                    .try_into_commit()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                Some(parent.tree().map_err(|e| GitError::Gix(e.to_string()))?)
            }
            None => None,
        };

        Ok((old_tree, new_tree))
    }

    /// Changes between a commit and its first parent. Rewrite (rename/copy) tracking is
    /// deliberately disabled — it's config-dependent and turns this into a fuzzy, expensive
    /// N×M match; a rename shows up as a delete + an add, which P1-04 doesn't need to resolve.
    ///
    /// With path tracking on, `gix_diff::tree_with_rewrites` also emits an entry per changed
    /// *directory* (mode `Tree`) to make hierarchy reconstruction possible — those aren't
    /// diffable blobs and aren't "files" in any sense the frontend cares about, so they're
    /// filtered out here rather than in every caller.
    pub(super) fn commit_changes(
        git: &gix::Repository,
        commit_id: &str,
    ) -> Result<Vec<ChangeDetached>, GitError> {
        let (old_tree, new_tree) = Self::commit_trees(git, commit_id)?;
        Self::tree_changes(git, old_tree.as_ref(), &new_tree)
    }

    pub(super) fn tree_changes(
        git: &gix::Repository,
        old_tree: Option<&gix::Tree<'_>>,
        new_tree: &gix::Tree<'_>,
    ) -> Result<Vec<ChangeDetached>, GitError> {
        let mut options = gix::diff::Options::default();
        options.track_rewrites(None);
        let changes = git
            .diff_tree_to_tree(old_tree, new_tree, Some(options))
            .map_err(|e| GitError::Gix(e.to_string()))?;
        Ok(changes
            .into_iter()
            .filter(|change| change.attach(git, git).entry_mode().is_blob_or_symlink())
            .collect())
    }

    /// Collects every file's line counts in one Git process. The previous
    /// implementation prepared and diffed each blob separately, making the
    /// inspector latency proportional to N independent diff setups.
    pub(super) fn commit_line_stats(
        commands: &GitCommandFactory,
        repo: &RepoPath,
        commit_id: &str,
        old_tree: Option<&gix::Tree<'_>>,
        new_tree: &gix::Tree<'_>,
    ) -> Result<HashMap<String, (u32, u32)>, GitError> {
        let mut command = commands.command()?;
        command.current_dir(&repo.0).stdin(Stdio::null());

        if let Some(old_tree) = old_tree {
            command
                .args([
                    "diff",
                    "--numstat",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-z",
                ])
                .arg(old_tree.id.to_string())
                .arg(new_tree.id.to_string());
        } else {
            command
                .args([
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--numstat",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-r",
                    "-z",
                ])
                .arg(commit_id);
        }

        let output = command.output().map_err(|error| {
            GitError::Git2(format!("failed to read commit statistics: {error}"))
        })?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr);
            return Err(GitError::Git2(format!(
                "failed to read commit statistics: {}",
                message.trim()
            )));
        }

        Ok(Self::parse_numstat(&output.stdout))
    }

    pub(super) fn parse_numstat(output: &[u8]) -> HashMap<String, (u32, u32)> {
        output
            .split(|byte| *byte == 0)
            .filter_map(|record| {
                if record.is_empty() {
                    return None;
                }
                let mut fields = record.splitn(3, |byte| *byte == b'\t');
                let additions = parse_numstat_count(fields.next()?)?;
                let deletions = parse_numstat_count(fields.next()?)?;
                let path = String::from_utf8_lossy(fields.next()?).into_owned();
                Some((path, (additions, deletions)))
            })
            .collect()
    }

    pub(super) fn classify_delta(status: git2::Delta) -> FileChangeType {
        match status {
            git2::Delta::Added | git2::Delta::Untracked | git2::Delta::Copied => {
                FileChangeType::Added
            }
            git2::Delta::Deleted => FileChangeType::Deleted,
            git2::Delta::Renamed => FileChangeType::Renamed,
            _ => FileChangeType::Modified,
        }
    }

    /// Collects a git2 diff into domain hunks. Used for uncommitted work,
    /// where `gix`'s tree-to-tree path doesn't apply — there's no second tree.
    pub(super) fn collect_git2_diff(
        diff: &git2::Diff<'_>,
    ) -> Result<(bool, Vec<DiffHunk>), GitError> {
        // The hunk and line callbacks both need to reach the same buffer, and
        // `foreach` holds all of them at once — hence the shared cells rather
        // than plain `&mut` captures.
        let hunks: std::cell::RefCell<Vec<DiffHunk>> = std::cell::RefCell::new(Vec::new());
        let is_binary = std::cell::Cell::new(false);
        let invalid_utf8 = std::cell::Cell::new(false);

        diff.foreach(
            &mut |_delta, _progress| true,
            Some(&mut |_delta, _binary| {
                is_binary.set(true);
                true
            }),
            Some(&mut |_delta, hunk| {
                hunks.borrow_mut().push(DiffHunk {
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
                true
            }),
            Some(&mut |_delta, _hunk, line| {
                let mut hunks = hunks.borrow_mut();
                let Some(current) = hunks.last_mut() else {
                    return true;
                };
                let kind = match line.origin() {
                    '+' => DiffLineKind::Addition,
                    '-' => DiffLineKind::Deletion,
                    ' ' => DiffLineKind::Context,
                    // libgit2 reports the familiar `No newline at end of
                    // file` marker as a separate callback. The preceding
                    // content line already carries `DiffLineEnding::None`, so
                    // the marker must not become a selectable context row.
                    '<' | '>' | '=' => return true,
                    _ => return true,
                };
                let Some((content, line_ending)) = split_diff_line(line.content()) else {
                    invalid_utf8.set(true);
                    return false;
                };
                current.lines.push(DiffLine {
                    kind,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content,
                    line_ending: Some(line_ending),
                });
                true
            }),
        )
        .map_err(Self::map_git2_error)?;

        if invalid_utf8.get() {
            return Err(GitError::PatchUnsupported(
                "non-UTF-8 text cannot be represented by the rendered diff model".to_string(),
            ));
        }

        Ok((is_binary.get(), hunks.into_inner()))
    }

    pub(super) fn classify_change(change: &Change<'_, '_, '_>) -> FileChangeType {
        match change {
            Change::Addition { .. } => FileChangeType::Added,
            Change::Deletion { .. } => FileChangeType::Deleted,
            Change::Modification { .. } => FileChangeType::Modified,
            Change::Rewrite { .. } => FileChangeType::Renamed,
        }
    }
}

pub(super) async fn diff_files(
    repo: &RepoPath,
    commit_id: &str,
) -> Result<Vec<FileDiff>, GitError> {
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
        let changes = LocalGitBackend::commit_changes(&git, &commit_id)?;
        Ok(changes
            .iter()
            .map(|change| {
                let attached = change.attach(&git, &git);
                FileDiff {
                    path: attached.location().to_string(),
                    change_type: LocalGitBackend::classify_change(&attached),
                    additions: 0,
                    deletions: 0,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}

pub(super) async fn diff(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    commit_id: &str,
) -> Result<Vec<FileDiff>, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
        let (old_tree, new_tree) = LocalGitBackend::commit_trees(&git, &commit_id)?;
        let changes = LocalGitBackend::tree_changes(&git, old_tree.as_ref(), &new_tree)?;
        let mut line_stats = LocalGitBackend::commit_line_stats(
            &commands,
            &repo,
            &commit_id,
            old_tree.as_ref(),
            &new_tree,
        )?;

        let mut out = Vec::with_capacity(changes.len());
        for change in &changes {
            let attached = change.attach(&git, &git);
            let path = attached.location().to_string();
            let change_type = LocalGitBackend::classify_change(&attached);
            let (additions, deletions) = line_stats.remove(&path).unwrap_or_default();
            out.push(FileDiff {
                path,
                change_type,
                additions,
                deletions,
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}

pub(super) async fn file_diff(
    repo: &RepoPath,
    commit_id: &str,
    path: &str,
) -> Result<FileDiffDetail, GitError> {
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let path = path.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
        let changes = LocalGitBackend::commit_changes(&git, &commit_id)?;

        let change = changes
            .iter()
            .find(|change| change.attach(&git, &git).location() == path)
            .ok_or_else(|| {
                GitError::Gix(format!(
                    "no change found for path '{path}' in commit {commit_id}"
                ))
            })?;
        let attached = change.attach(&git, &git);
        let change_type = LocalGitBackend::classify_change(&attached);

        let mut resource_cache = git
            .diff_resource_cache_for_tree_diff()
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let platform = attached
            .diff(&mut resource_cache)
            .map_err(|e| GitError::Gix(e.to_string()))?;
        platform
            .resource_cache
            .options
            .skip_internal_diff_if_external_is_configured = false;

        let prep = platform
            .resource_cache
            .prepare_diff()
            .map_err(|e| GitError::Gix(e.to_string()))?;

        let (is_binary, hunks) = match prep.operation {
            Operation::InternalDiff { algorithm } => {
                let input = prep.interned_input();
                let diff = gix::diff::blob::diff_with_slider_heuristics(algorithm, &input);
                let hunks = UnifiedDiff::new(
                    &diff,
                    &input,
                    HunkCollector::default(),
                    ContextSize::symmetrical(3),
                )
                .consume()
                .map_err(|e| GitError::Gix(e.to_string()))?;
                (false, hunks)
            }
            Operation::ExternalCommand { .. } | Operation::SourceOrDestinationIsBinary => {
                (true, Vec::new())
            }
        };

        Ok(FileDiffDetail {
            path,
            change_type,
            old_mode: None,
            new_mode: None,
            is_binary,
            hunks,
        })
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}

pub(super) async fn file_diff_window(
    repo: &RepoPath,
    commit_id: &str,
    path: &str,
    offset: u32,
    limit: u32,
    max_file_bytes: u64,
) -> Result<FileDiffWindow, GitError> {
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let path = path.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
        let changes = LocalGitBackend::commit_changes(&git, &commit_id)?;
        let change = changes
            .iter()
            .find(|change| change.attach(&git, &git).location() == path)
            .ok_or_else(|| {
                GitError::Gix(format!(
                    "no change found for path '{path}' in commit {commit_id}"
                ))
            })?;
        let attached = change.attach(&git, &git);
        let change_type = LocalGitBackend::classify_change(&attached);
        let mut resource_cache = git
            .diff_resource_cache_for_tree_diff()
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let platform = attached
            .diff(&mut resource_cache)
            .map_err(|e| GitError::Gix(e.to_string()))?;
        platform
            .resource_cache
            .options
            .skip_internal_diff_if_external_is_configured = false;
        let prep = platform
            .resource_cache
            .prepare_diff()
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let file_bytes = resource_size(prep.old.data).max(resource_size(prep.new.data));

        if file_bytes > max_file_bytes {
            return Ok(FileDiffWindow {
                path,
                change_type,
                old_mode: None,
                new_mode: None,
                is_binary: matches!(prep.operation, Operation::SourceOrDestinationIsBinary),
                too_large: true,
                file_bytes,
                hunks: Vec::new(),
                total_hunks: 0,
                total_lines: resource_line_count(prep.old.data)
                    .max(resource_line_count(prep.new.data)),
                truncated: false,
                next_offset: None,
                base_digest: None,
            });
        }

        match prep.operation {
            Operation::InternalDiff { algorithm } => {
                let input = prep.interned_input();
                let diff = gix::diff::blob::diff_with_slider_heuristics(algorithm, &input);
                let collected = UnifiedDiff::new(
                    &diff,
                    &input,
                    WindowedHunkCollector::new(offset, limit),
                    ContextSize::symmetrical(3),
                )
                .consume()
                .map_err(|e| GitError::Gix(e.to_string()))?;
                let truncated = collected.end < collected.total_lines;
                Ok(FileDiffWindow {
                    path,
                    change_type,
                    old_mode: None,
                    new_mode: None,
                    is_binary: false,
                    too_large: false,
                    file_bytes,
                    hunks: collected.hunks,
                    total_hunks: collected.total_hunks,
                    total_lines: collected.total_lines,
                    truncated,
                    next_offset: truncated.then_some(collected.end),
                    base_digest: None,
                })
            }
            Operation::ExternalCommand { .. } | Operation::SourceOrDestinationIsBinary => {
                Ok(FileDiffWindow {
                    path,
                    change_type,
                    old_mode: None,
                    new_mode: None,
                    is_binary: true,
                    too_large: false,
                    file_bytes,
                    hunks: Vec::new(),
                    total_hunks: 0,
                    total_lines: 0,
                    truncated: false,
                    next_offset: None,
                    base_digest: None,
                })
            }
        }
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}

fn resource_size(data: gix::diff::blob::platform::resource::Data<'_>) -> u64 {
    match data {
        gix::diff::blob::platform::resource::Data::Missing => 0,
        gix::diff::blob::platform::resource::Data::Buffer { buf, .. } => buf.len() as u64,
        gix::diff::blob::platform::resource::Data::Binary { size } => size,
    }
}

fn resource_line_count(data: gix::diff::blob::platform::resource::Data<'_>) -> u32 {
    let Some(bytes) = data.as_slice() else {
        return 0;
    };
    if bytes.is_empty() {
        return 0;
    }
    bytes.iter().filter(|byte| **byte == b'\n').count() as u32
        + u32::from(bytes.last() != Some(&b'\n'))
}

fn split_diff_line(content: &[u8]) -> Option<(String, DiffLineEnding)> {
    let (content, line_ending) = if let Some(content) = content.strip_suffix(b"\r\n") {
        (content, DiffLineEnding::Crlf)
    } else if let Some(content) = content.strip_suffix(b"\n") {
        (content, DiffLineEnding::Lf)
    } else {
        (content, DiffLineEnding::None)
    };
    Some((std::str::from_utf8(content).ok()?.to_string(), line_ending))
}

struct WindowedHunkCollector {
    start: u32,
    end: u32,
    cursor: u32,
    total_hunks: u32,
    hunks: Vec<DiffHunk>,
}

struct WindowedHunks {
    end: u32,
    total_hunks: u32,
    total_lines: u32,
    hunks: Vec<DiffHunk>,
}

impl WindowedHunkCollector {
    fn new(offset: u32, limit: u32) -> Self {
        Self {
            start: offset,
            end: offset.saturating_add(limit),
            cursor: 0,
            total_hunks: 0,
            hunks: Vec::new(),
        }
    }
}

impl ConsumeHunk for WindowedHunkCollector {
    type Out = WindowedHunks;

    fn consume_hunk(
        &mut self,
        header: HunkHeader,
        lines: &[(gix::diff::blob::unified_diff::DiffLineKind, &[u8])],
    ) -> std::io::Result<()> {
        use gix::diff::blob::unified_diff::DiffLineKind as GixLineKind;
        self.total_hunks += 1;
        let mut old_line = header.before_hunk_start;
        let mut new_line = header.after_hunk_start;
        let mut selected = Vec::new();

        for (kind, content) in lines {
            let position = self.cursor;
            self.cursor = self.cursor.saturating_add(1);
            let (kind, old_lineno, new_lineno) = match kind {
                GixLineKind::Context => {
                    let result = (DiffLineKind::Context, Some(old_line), Some(new_line));
                    old_line += 1;
                    new_line += 1;
                    result
                }
                GixLineKind::Add => {
                    let result = (DiffLineKind::Addition, None, Some(new_line));
                    new_line += 1;
                    result
                }
                GixLineKind::Remove => {
                    let result = (DiffLineKind::Deletion, Some(old_line), None);
                    old_line += 1;
                    result
                }
            };
            if position >= self.start && position < self.end {
                selected.push(DiffLine {
                    kind,
                    old_lineno,
                    new_lineno,
                    content: String::from_utf8_lossy(content).into_owned(),
                    line_ending: None,
                });
            }
        }

        if !selected.is_empty() {
            self.hunks.push(DiffHunk {
                old_start: header.before_hunk_start,
                old_lines: header.before_hunk_len,
                new_start: header.after_hunk_start,
                new_lines: header.after_hunk_len,
                lines: selected,
            });
        }
        Ok(())
    }

    fn finish(self) -> Self::Out {
        WindowedHunks {
            end: self.end.min(self.cursor),
            total_hunks: self.total_hunks,
            total_lines: self.cursor,
            hunks: self.hunks,
        }
    }
}

/// Collects unified-diff hunks into `fjord_domain::DiffHunk`s, assigning old/new line numbers
/// as it walks each hunk's context/addition/deletion lines in order.
#[derive(Default)]
struct HunkCollector {
    hunks: Vec<DiffHunk>,
}

impl ConsumeHunk for HunkCollector {
    type Out = Vec<DiffHunk>;

    fn consume_hunk(
        &mut self,
        header: HunkHeader,
        lines: &[(gix::diff::blob::unified_diff::DiffLineKind, &[u8])],
    ) -> std::io::Result<()> {
        use gix::diff::blob::unified_diff::DiffLineKind as GixLineKind;

        let mut old_line = header.before_hunk_start;
        let mut new_line = header.after_hunk_start;
        let mut out_lines = Vec::with_capacity(lines.len());

        for (kind, content) in lines {
            let content = String::from_utf8_lossy(content).into_owned();
            let (kind, old_lineno, new_lineno) = match kind {
                GixLineKind::Context => {
                    let line = (Some(old_line), Some(new_line));
                    old_line += 1;
                    new_line += 1;
                    (DiffLineKind::Context, line.0, line.1)
                }
                GixLineKind::Add => {
                    let n = new_line;
                    new_line += 1;
                    (DiffLineKind::Addition, None, Some(n))
                }
                GixLineKind::Remove => {
                    let o = old_line;
                    old_line += 1;
                    (DiffLineKind::Deletion, Some(o), None)
                }
            };
            out_lines.push(DiffLine {
                kind,
                old_lineno,
                new_lineno,
                content,
                line_ending: None,
            });
        }

        self.hunks.push(DiffHunk {
            old_start: header.before_hunk_start,
            old_lines: header.before_hunk_len,
            new_start: header.after_hunk_start,
            new_lines: header.after_hunk_len,
            lines: out_lines,
        });
        Ok(())
    }

    fn finish(self) -> Self::Out {
        self.hunks
    }
}

fn parse_numstat_count(value: &[u8]) -> Option<u32> {
    if value == b"-" {
        return Some(0);
    }
    std::str::from_utf8(value).ok()?.parse().ok()
}
