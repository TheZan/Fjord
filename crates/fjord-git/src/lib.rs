//! `GitBackend` implementation: `gix` for the hot read paths, `git2` for
//! what `gix` doesn't cover yet (fetch/pull/push today). See
//! docs/specs/git-backend.md for the full routing table and rationale.

use std::path::PathBuf;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitId, CommitPage, CommitSummary, DiffHunk, DiffLine, DiffLineKind,
    FileChangeType, FileDiff, FileDiffDetail, LogCursor, RepoStatus,
};
use fjord_ports::{GitBackend, GitError, RepoPath};
use gix::diff::blob::platform::prepare_diff::Operation;
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, HunkHeader};
use gix::diff::blob::UnifiedDiff;
use gix::object::tree::diff::{Change, ChangeDetached};
use gix::prelude::TreeDiffChangeExt;
use time::OffsetDateTime;

pub struct GixGitBackend;

impl GixGitBackend {
    pub fn new() -> Self {
        Self
    }

    fn open(repo: &RepoPath) -> Result<gix::Repository, GitError> {
        gix::open(&repo.0).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => GitError::NotAGitRepository(repo.0.clone()),
            other => GitError::Gix(other.to_string()),
        })
    }

    fn open_git2(repo: &RepoPath) -> Result<git2::Repository, GitError> {
        git2::Repository::open(&repo.0).map_err(|e| GitError::Git2(e.message().to_string()))
    }

    /// The commit's tree and its first parent's tree (`None` for a root commit), which
    /// together define the changeset shown for that commit — see docs/specs/git-backend.md.
    fn commit_trees<'r>(
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
    fn commit_changes(
        git: &gix::Repository,
        commit_id: &str,
    ) -> Result<Vec<ChangeDetached>, GitError> {
        let (old_tree, new_tree) = Self::commit_trees(git, commit_id)?;
        let mut options = gix::diff::Options::default();
        options.track_rewrites(None);
        let changes = git
            .diff_tree_to_tree(old_tree.as_ref(), &new_tree, Some(options))
            .map_err(|e| GitError::Gix(e.to_string()))?;
        Ok(changes
            .into_iter()
            .filter(|change| change.attach(git, git).entry_mode().is_blob_or_symlink())
            .collect())
    }

    fn classify_change(change: &Change<'_, '_, '_>) -> FileChangeType {
        match change {
            Change::Addition { .. } => FileChangeType::Added,
            Change::Deletion { .. } => FileChangeType::Deleted,
            Change::Modification { .. } => FileChangeType::Modified,
            Change::Rewrite { .. } => FileChangeType::Renamed,
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

impl Default for GixGitBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GitBackend for GixGitBackend {
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;

            let branch = git
                .head_name()
                .map_err(|e| GitError::Gix(e.to_string()))?
                .map(|name| name.shorten().to_string());

            let dirty_count = git
                .status(gix::progress::Discard)
                .map_err(|e| GitError::Gix(e.to_string()))?
                .into_iter(None)
                .map_err(|e| GitError::Gix(e.to_string()))?
                .filter(|entry| entry.is_ok())
                .count() as u32;

            // Ahead/behind against the branch's upstream is left at 0 until
            // P1-06/P1-07 wire up remote-tracking comparison — status/dirty
            // detection is what P0-03 exists to prove out.
            Ok(RepoStatus {
                branch,
                ahead: 0,
                behind: 0,
                dirty_count,
                has_conflict: false,
            })
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let current = git
                .head_name()
                .map_err(|e| GitError::Gix(e.to_string()))?
                .map(|name| name.shorten().to_string());

            let platform = git.references().map_err(|e| GitError::Gix(e.to_string()))?;
            let mut out = Vec::new();

            for branch in platform
                .local_branches()
                .map_err(|e| GitError::Gix(e.to_string()))?
            {
                let branch = branch.map_err(|e| GitError::Gix(e.to_string()))?;
                let name = branch.name().shorten().to_string();
                out.push(BranchInfo {
                    is_current: Some(&name) == current.as_ref(),
                    name,
                    is_remote: false,
                    upstream: None,
                });
            }

            for branch in platform
                .remote_branches()
                .map_err(|e| GitError::Gix(e.to_string()))?
            {
                let branch = branch.map_err(|e| GitError::Gix(e.to_string()))?;
                out.push(BranchInfo {
                    name: branch.name().shorten().to_string(),
                    is_current: false,
                    is_remote: true,
                    upstream: None,
                });
            }

            Ok(out)
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn log(
        &self,
        repo: &RepoPath,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, GitError> {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;

            let start = match from {
                Some(cursor) => gix::ObjectId::from_hex(cursor.0.as_bytes())
                    .map_err(|e| GitError::Gix(e.to_string()))?,
                None => git
                    .head_id()
                    .map_err(|e| GitError::Gix(e.to_string()))?
                    .detach(),
            };

            let walk = git
                .rev_walk(Some(start))
                .all()
                .map_err(|e| GitError::Gix(e.to_string()))?;

            let mut commits = Vec::new();
            let mut next_cursor = None;

            for (i, info) in walk.enumerate() {
                if i as u32 >= limit {
                    if let Ok(info) = info {
                        next_cursor = Some(LogCursor(info.id.to_string()));
                    }
                    break;
                }
                let info = info.map_err(|e| GitError::Gix(e.to_string()))?;
                let commit = info.object().map_err(|e| GitError::Gix(e.to_string()))?;
                let decoded = commit.decode().map_err(|e| GitError::Gix(e.to_string()))?;
                let author = decoded.author().map_err(|e| GitError::Gix(e.to_string()))?;

                commits.push(CommitSummary {
                    id: CommitId(info.id.to_string()),
                    parent_ids: info
                        .parent_ids
                        .iter()
                        .map(|id| CommitId(id.to_string()))
                        .collect(),
                    message: String::from_utf8_lossy(decoded.message).into_owned(),
                    author_name: author.name.to_string(),
                    author_email: author.email.to_string(),
                    authored_at: OffsetDateTime::from_unix_timestamp(author.seconds())
                        .unwrap_or(OffsetDateTime::UNIX_EPOCH),
                    refs: Vec::new(),
                });
            }

            Ok(CommitPage {
                commits,
                next_cursor,
            })
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn diff(&self, repo: &RepoPath, commit_id: &str) -> Result<Vec<FileDiff>, GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let changes = Self::commit_changes(&git, &commit_id)?;

            let mut resource_cache = git
                .diff_resource_cache_for_tree_diff()
                .map_err(|e| GitError::Gix(e.to_string()))?;

            let mut out = Vec::with_capacity(changes.len());
            for change in &changes {
                let attached = change.attach(&git, &git);
                let path = attached.location().to_string();
                let change_type = Self::classify_change(&attached);

                let (additions, deletions) = attached
                    .diff(&mut resource_cache)
                    .ok()
                    .and_then(|mut platform| platform.line_counts().ok().flatten())
                    .map(|counts| (counts.insertions, counts.removals))
                    .unwrap_or((0, 0));

                resource_cache.clear_resource_cache_keep_allocation();
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

    async fn file_diff(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
    ) -> Result<FileDiffDetail, GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let changes = Self::commit_changes(&git, &commit_id)?;

            let change = changes
                .iter()
                .find(|change| change.attach(&git, &git).location() == path)
                .ok_or_else(|| {
                    GitError::Gix(format!(
                        "no change found for path '{path}' in commit {commit_id}"
                    ))
                })?;
            let attached = change.attach(&git, &git);
            let change_type = Self::classify_change(&attached);

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

    async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented(
            "checkout lands in Phase 1, see plan.md P1-06",
        ))
    }

    async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
        Err(GitError::NotImplemented(
            "stage lands in Phase 1, see plan.md P1-06",
        ))
    }

    async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
        Err(GitError::NotImplemented(
            "commit lands in Phase 1, see plan.md P1-06",
        ))
    }

    async fn fetch(&self, repo: &RepoPath, remote: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let remote = remote.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut r = git
                .find_remote(&remote)
                .map_err(|e| GitError::Git2(e.message().to_string()))?;
            r.fetch(&[] as &[&str], None, None)
                .map_err(|e| GitError::Git2(e.message().to_string()))
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn pull(&self, _repo: &RepoPath) -> Result<(), GitError> {
        Err(GitError::NotImplemented(
            "pull (fetch + merge) lands in Phase 1, see plan.md P1-06",
        ))
    }

    async fn push(&self, _repo: &RepoPath, _refspec: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented(
            "push lands in Phase 1, see plan.md P1-07",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `status`/`branches`/`log` against *this very repository* as the
    /// fixture — the cheapest possible real integration test, per
    /// docs/SDD.md §8 ("integration tests against real fixture
    /// repositories").
    fn this_repo_path() -> RepoPath {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/fjord-git is two levels under the repo root");
        RepoPath(repo_root.to_path_buf())
    }

    #[tokio::test]
    async fn status_reports_a_branch_name() {
        let backend = GixGitBackend::new();
        let status = backend.status(&this_repo_path()).await.unwrap();
        assert!(status.branch.is_some());
    }

    #[tokio::test]
    async fn branches_includes_the_current_branch() {
        let backend = GixGitBackend::new();
        let branches = backend.branches(&this_repo_path()).await.unwrap();
        assert!(branches.iter().any(|b| b.is_current));
    }

    #[tokio::test]
    async fn log_returns_at_least_one_commit() {
        let backend = GixGitBackend::new();
        let page = backend.log(&this_repo_path(), None, 5).await.unwrap();
        assert!(!page.commits.is_empty());
    }

    #[tokio::test]
    async fn diff_reports_changed_files_for_head() {
        let backend = GixGitBackend::new();
        let page = backend.log(&this_repo_path(), None, 1).await.unwrap();
        let head = &page.commits[0].id.0;

        let files = backend.diff(&this_repo_path(), head).await.unwrap();
        assert!(
            !files.is_empty(),
            "HEAD should have touched at least one file"
        );
    }

    #[tokio::test]
    async fn file_diff_reports_hunks_for_a_file_changed_in_head() {
        let backend = GixGitBackend::new();
        let page = backend.log(&this_repo_path(), None, 1).await.unwrap();
        let head = &page.commits[0].id.0;
        let files = backend.diff(&this_repo_path(), head).await.unwrap();
        let file = files
            .first()
            .expect("HEAD should have touched at least one file");

        let detail = backend
            .file_diff(&this_repo_path(), head, &file.path)
            .await
            .unwrap();
        assert_eq!(detail.path, file.path);
        if !detail.is_binary {
            assert!(!detail.hunks.is_empty());
            for hunk in &detail.hunks {
                assert!(!hunk.lines.is_empty());
            }
        }
    }
}
