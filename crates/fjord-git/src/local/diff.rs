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
                    _ => DiffLineKind::Context,
                };
                // git2 hands back the raw line including its newline; the
                // frontend renders one row per line and adds its own.
                let content = String::from_utf8_lossy(line.content())
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                current.lines.push(DiffLine {
                    kind,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content,
                });
                true
            }),
        )
        .map_err(Self::map_git2_error)?;

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
            is_binary,
            hunks,
        })
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
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
