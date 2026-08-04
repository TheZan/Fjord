//! `GitBackend` implementation: `gix` for the hot read paths, `git2` for
//! what `gix` doesn't cover yet (fetch/pull/push today). See
//! docs/specs/git-backend.md for the full routing table and rationale.

use std::path::PathBuf;

use async_trait::async_trait;
use fjord_domain::{BranchInfo, CommitPage, CommitId, CommitSummary, FileDiff, LogCursor, RepoStatus};
use fjord_ports::{GitBackend, GitError, RepoPath};
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
                    parent_ids: info.parent_ids.iter().map(|id| CommitId(id.to_string())).collect(),
                    message: String::from_utf8_lossy(decoded.message).into_owned(),
                    author_name: author.name.to_string(),
                    author_email: author.email.to_string(),
                    authored_at: OffsetDateTime::from_unix_timestamp(author.seconds())
                        .unwrap_or(OffsetDateTime::UNIX_EPOCH),
                    refs: Vec::new(),
                });
            }

            Ok(CommitPage { commits, next_cursor })
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn diff(&self, _repo: &RepoPath, _commit_id: &str) -> Result<Vec<FileDiff>, GitError> {
        Err(GitError::NotImplemented("diff lands in Phase 1, see plan.md P1-05"))
    }

    async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("checkout lands in Phase 1, see plan.md P1-06"))
    }

    async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
        Err(GitError::NotImplemented("stage lands in Phase 1, see plan.md P1-06"))
    }

    async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
        Err(GitError::NotImplemented("commit lands in Phase 1, see plan.md P1-06"))
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
        Err(GitError::NotImplemented("pull (fetch + merge) lands in Phase 1, see plan.md P1-06"))
    }

    async fn push(&self, _repo: &RepoPath, _refspec: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("push lands in Phase 1, see plan.md P1-07"))
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
}
