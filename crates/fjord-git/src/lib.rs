//! `GitBackend` implementation: `gix` for the hot read paths, `git2` for
//! what `gix` doesn't cover yet (fetch/pull/push today). See
//! docs/specs/git-backend.md for the full routing table and rationale.

use std::path::PathBuf;
use std::process::Command;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitId, CommitPage, CommitSummary, DiffHunk, DiffLine, DiffLineKind,
    FileChangeType, FileDiff, FileDiffDetail, LogCursor, RepoStatus,
};
use fjord_ports::{GitBackend, GitError, RepoPath};
use git2::build::CheckoutBuilder;
use git2::{Cred, ErrorCode, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks};
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
        git2::Repository::open(&repo.0).map_err(Self::map_git2_error)
    }

    fn map_git2_error(err: git2::Error) -> GitError {
        match err.code() {
            ErrorCode::Auth => GitError::AuthenticationFailed,
            ErrorCode::Conflict | ErrorCode::MergeConflict | ErrorCode::Unmerged => {
                GitError::Conflict { paths: vec![] }
            }
            _ => GitError::Git2(err.message().to_string()),
        }
    }

    fn remote_callbacks() -> RemoteCallbacks<'static> {
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(|_url, username_from_url, allowed| {
            if allowed.is_ssh_key() {
                if let Some(username) = username_from_url {
                    if let Ok(cred) = Cred::ssh_key_from_agent(username) {
                        return Ok(cred);
                    }
                }
            }

            Cred::default().or_else(|_| {
                username_from_url
                    .map(Cred::username)
                    .unwrap_or_else(Cred::default)
            })
        });
        callbacks
    }

    fn fetch_options() -> FetchOptions<'static> {
        let mut options = FetchOptions::new();
        options.remote_callbacks(Self::remote_callbacks());
        options
    }

    fn push_options() -> PushOptions<'static> {
        let mut callbacks = Self::remote_callbacks();
        callbacks.push_update_reference(|refname, status| {
            status
                .map(|message| Err(git2::Error::from_str(&format!("{refname}: {message}"))))
                .unwrap_or(Ok(()))
        });

        let mut options = PushOptions::new();
        options.remote_callbacks(callbacks);
        options
    }

    fn fetch_remote(
        git: &git2::Repository,
        remote_name: &str,
        refspecs: &[&str],
    ) -> Result<(), GitError> {
        let mut remote = git.find_remote(remote_name).map_err(Self::map_git2_error)?;
        let mut options = Self::fetch_options();
        remote
            .fetch(refspecs, Some(&mut options), None)
            .map_err(Self::map_git2_error)
    }

    fn current_branch_refname(git: &git2::Repository) -> Result<String, GitError> {
        let head = git.head().map_err(Self::map_git2_error)?;
        let head_refname = head.name().map_err(Self::map_git2_error)?.to_string();

        if !head_refname.starts_with("refs/heads/") {
            return Err(GitError::NoUpstream);
        }

        Ok(head_refname)
    }

    fn conflict_paths(index: &git2::Index) -> Vec<String> {
        index
            .conflicts()
            .map(|conflicts| {
                conflicts
                    .filter_map(Result::ok)
                    .filter_map(|conflict| conflict.our.or(conflict.their).or(conflict.ancestor))
                    .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn has_conflicts(repo: &RepoPath) -> Result<bool, GitError> {
        let git = Self::open_git2(repo)?;
        Ok(git.index().map_err(Self::map_git2_error)?.has_conflicts())
    }

    fn current_head_commit(git: &git2::Repository) -> Result<Option<git2::Commit<'_>>, GitError> {
        match git.head() {
            Ok(head) => Ok(Some(head.peel_to_commit().map_err(Self::map_git2_error)?)),
            Err(err) if matches!(err.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                Ok(None)
            }
            Err(err) => Err(Self::map_git2_error(err)),
        }
    }

    fn fast_forward(
        git: &git2::Repository,
        local_refname: &str,
        remote_commit: &git2::AnnotatedCommit<'_>,
    ) -> Result<(), GitError> {
        let mut local_ref = git
            .find_reference(local_refname)
            .map_err(Self::map_git2_error)?;
        local_ref
            .set_target(
                remote_commit.id(),
                &format!("Fast-forward {local_refname} to {}", remote_commit.id()),
            )
            .map_err(Self::map_git2_error)?;
        git.set_head(local_refname).map_err(Self::map_git2_error)?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_head(Some(&mut checkout))
            .map_err(Self::map_git2_error)
    }

    fn normal_merge(
        git: &git2::Repository,
        local_commit: &git2::AnnotatedCommit<'_>,
        remote_commit: &git2::AnnotatedCommit<'_>,
    ) -> Result<(), GitError> {
        let local = git
            .find_commit(local_commit.id())
            .map_err(Self::map_git2_error)?;
        let remote = git
            .find_commit(remote_commit.id())
            .map_err(Self::map_git2_error)?;
        let ancestor = git
            .find_commit(
                git.merge_base(local_commit.id(), remote_commit.id())
                    .map_err(Self::map_git2_error)?,
            )
            .map_err(Self::map_git2_error)?;
        let mut index = git
            .merge_trees(
                &ancestor.tree().map_err(Self::map_git2_error)?,
                &local.tree().map_err(Self::map_git2_error)?,
                &remote.tree().map_err(Self::map_git2_error)?,
                None,
            )
            .map_err(Self::map_git2_error)?;

        if index.has_conflicts() {
            let paths = Self::conflict_paths(&index);
            let mut checkout = CheckoutBuilder::new();
            checkout.allow_conflicts(true).conflict_style_merge(true);
            git.checkout_index(Some(&mut index), Some(&mut checkout))
                .map_err(Self::map_git2_error)?;
            return Err(GitError::Conflict { paths });
        }

        let tree_oid = index.write_tree_to(git).map_err(Self::map_git2_error)?;
        let tree = git.find_tree(tree_oid).map_err(Self::map_git2_error)?;
        let signature = git.signature().map_err(Self::map_git2_error)?;
        let message = format!("Merge {} into {}", remote_commit.id(), local_commit.id());
        git.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message,
            &tree,
            &[&local, &remote],
        )
        .map_err(Self::map_git2_error)?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_head(Some(&mut checkout))
            .map_err(Self::map_git2_error)
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

            let has_conflict = Self::has_conflicts(&repo)?;

            // Ahead/behind against the branch's upstream is left at 0 until
            // P2 status-cache work wires up remote-tracking comparison —
            // status/dirty/conflict detection is what the single-repo phases
            // need to prove out first.
            Ok(RepoStatus {
                branch,
                ahead: 0,
                behind: 0,
                dirty_count,
                has_conflict,
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

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let branch = branch.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let refname = if branch.starts_with("refs/") {
                branch
            } else {
                format!("refs/heads/{branch}")
            };

            git.find_reference(&refname).map_err(Self::map_git2_error)?;
            git.set_head(&refname).map_err(Self::map_git2_error)?;
            let mut checkout = CheckoutBuilder::new();
            checkout.safe();
            git.checkout_head(Some(&mut checkout))
                .map_err(Self::map_git2_error)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        let repo = repo.clone();
        let paths = paths.to_vec();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut index = git.index().map_err(Self::map_git2_error)?;

            if paths.is_empty() {
                index
                    .add_all(["*"], IndexAddOption::DEFAULT, None)
                    .map_err(Self::map_git2_error)?;
            } else {
                for path in &paths {
                    index.add_path(path).map_err(Self::map_git2_error)?;
                }
            }

            index.write().map_err(Self::map_git2_error)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        let repo = repo.clone();
        let paths = paths.to_vec();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head = git
                .head()
                .ok()
                .and_then(|head| head.peel(git2::ObjectType::Commit).ok());

            if paths.is_empty() {
                git.reset_default(head.as_ref(), ["*"])
                    .map_err(Self::map_git2_error)
            } else {
                git.reset_default(head.as_ref(), paths.iter())
                    .map_err(Self::map_git2_error)
            }
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError> {
        let repo = repo.clone();
        let message = message.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut index = git.index().map_err(Self::map_git2_error)?;
            if index.has_conflicts() {
                return Err(GitError::Conflict {
                    paths: Self::conflict_paths(&index),
                });
            }

            let tree_oid = index.write_tree().map_err(Self::map_git2_error)?;
            let tree = git.find_tree(tree_oid).map_err(Self::map_git2_error)?;
            let parent_commit = Self::current_head_commit(&git)?;

            if parent_commit
                .as_ref()
                .is_some_and(|parent| parent.tree_id() == tree_oid)
            {
                return Err(GitError::NothingToCommit);
            }

            let signature = git.signature().map_err(Self::map_git2_error)?;
            let parent_refs = parent_commit.iter().collect::<Vec<_>>();
            let oid = git
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &message,
                    &tree,
                    &parent_refs,
                )
                .map_err(Self::map_git2_error)?;
            Ok(oid.to_string())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn fetch(&self, repo: &RepoPath, remote: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let remote = remote.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            Self::fetch_remote(&git, &remote, &[])
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn pull(&self, repo: &RepoPath) -> Result<(), GitError> {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head = git.head().map_err(Self::map_git2_error)?;
            let head_refname = Self::current_branch_refname(&git)?;

            let upstream_refname = git
                .branch_upstream_name(&head_refname)
                .map_err(|err| match err.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => Self::map_git2_error(err),
                })?
                .as_str()
                .map_err(Self::map_git2_error)?
                .to_string();
            let remote_name = git
                .branch_upstream_remote(&head_refname)
                .map_err(Self::map_git2_error)?
                .as_str()
                .map_err(Self::map_git2_error)?
                .to_string();

            Self::fetch_remote(&git, &remote_name, &[])?;

            let upstream_ref = git
                .find_reference(&upstream_refname)
                .map_err(Self::map_git2_error)?;
            let remote_commit = git
                .reference_to_annotated_commit(&upstream_ref)
                .map_err(Self::map_git2_error)?;
            let analysis = git
                .merge_analysis(&[&remote_commit])
                .map_err(Self::map_git2_error)?;

            if analysis.0.is_up_to_date() {
                return Ok(());
            }

            if analysis.0.is_fast_forward() {
                return Self::fast_forward(&git, &head_refname, &remote_commit);
            }

            if analysis.0.is_normal() {
                let local_commit = git
                    .reference_to_annotated_commit(&head)
                    .map_err(Self::map_git2_error)?;
                return Self::normal_merge(&git, &local_commit, &remote_commit);
            }

            Ok(())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn push(&self, repo: &RepoPath, refspec: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let refspec = refspec.to_string();
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let refspec = if refspec.trim().is_empty() {
                let head_refname = Self::current_branch_refname(&git)?;
                format!("{head_refname}:{head_refname}")
            } else {
                refspec
            };

            let mut remote = git.find_remote("origin").map_err(Self::map_git2_error)?;
            let mut options = Self::push_options();
            remote
                .push(&[refspec], Some(&mut options))
                .map_err(Self::map_git2_error)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError> {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            if !Self::has_conflicts(&repo)? {
                return Err(GitError::NoConflicts);
            }

            Command::new("git")
                .args(["mergetool", "--no-prompt"])
                .current_dir(&repo.0)
                .spawn()
                .map(|_| ())
                .map_err(|e| GitError::MergeToolFailed(e.to_string()))
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, RepositoryInitOptions, Status};
    use std::path::Path;
    use tempfile::TempDir;

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

    fn empty_repo() -> (TempDir, RepoPath) {
        let dir = TempDir::new().unwrap();
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(dir.path(), &options).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Fjord Test").unwrap();
        config.set_str("user.email", "fjord@example.com").unwrap();
        let repo_path = RepoPath(dir.path().to_path_buf());
        (dir, repo_path)
    }

    fn write_file(repo: &RepoPath, path: &str, content: &str) {
        std::fs::write(repo.0.join(path), content).unwrap();
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

    #[tokio::test]
    async fn stage_and_commit_create_head_commit() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");

        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id()
                .to_string(),
            oid
        );
    }

    #[tokio::test]
    async fn unstage_removes_index_change_without_touching_worktree() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "first\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        write_file(&repo_path, "README.md", "second\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend
            .unstage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();

        let status = Repository::open(&repo_path.0)
            .unwrap()
            .status_file(Path::new("README.md"))
            .unwrap();
        assert!(!status.contains(Status::INDEX_MODIFIED));
        assert!(status.contains(Status::WT_MODIFIED));
    }

    #[tokio::test]
    async fn checkout_switches_local_branch() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend.checkout(&repo_path, "feature").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
    }

    #[tokio::test]
    async fn push_updates_origin_branch() {
        let (_local_dir, repo_path) = empty_repo();
        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();

        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let local_oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

        Repository::open(&repo_path.0)
            .unwrap()
            .remote("origin", remote_dir.path().to_str().unwrap())
            .unwrap();

        backend.push(&repo_path, "").await.unwrap();

        let remote = Repository::open_bare(remote_dir.path()).unwrap();
        let remote_oid = remote
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_oid.to_string(), local_oid);
    }

    #[tokio::test]
    async fn status_reports_merge_conflicts() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend.checkout(&repo_path, "feature").await.unwrap();
        write_file(&repo_path, "README.md", "feature\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Feature change").await.unwrap();

        backend.checkout(&repo_path, "main").await.unwrap();
        write_file(&repo_path, "README.md", "main\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Main change").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let feature_ref = repo.find_reference("refs/heads/feature").unwrap();
        let feature = repo.reference_to_annotated_commit(&feature_ref).unwrap();
        let mut checkout = CheckoutBuilder::new();
        checkout.allow_conflicts(true).conflict_style_merge(true);
        repo.merge(&[&feature], None, Some(&mut checkout)).unwrap();

        let status = backend.status(&repo_path).await.unwrap();
        assert!(status.has_conflict);
    }

    #[tokio::test]
    async fn open_merge_tool_requires_conflicts() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();

        let result = backend.open_merge_tool(&repo_path).await;

        assert!(matches!(result, Err(GitError::NoConflicts)));
    }
}
