use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use fjord_ports::{
    GitBackend, GitError, GitOperationContext, GitRemoteBackend, GitRemoteError, RepoPath,
};

/// Migration-only adapter retained until all legacy transport methods are
/// removed from the local port in P5-19.
pub struct LegacyGitRemoteBackend {
    backend: Arc<dyn GitBackend>,
}

impl LegacyGitRemoteBackend {
    pub fn new(backend: Arc<dyn GitBackend>) -> Self {
        Self { backend }
    }
}

fn legacy_remote_error(error: GitError) -> GitRemoteError {
    match error {
        GitError::AuthenticationFailed => GitRemoteError::AuthenticationFailed {
            stderr_tail: String::new(),
        },
        GitError::Cancelled => GitRemoteError::Cancelled,
        other => GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: other.to_string(),
            stderr_tail: String::new(),
        },
    }
}

#[async_trait]
impl GitRemoteBackend for LegacyGitRemoteBackend {
    async fn fetch(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        if !refspecs.is_empty() {
            return Err(GitRemoteError::ProcessFailed {
                exit_code: None,
                summary: "legacy backend does not support explicit fetch refspecs".into(),
                stderr_tail: String::new(),
            });
        }
        self.backend
            .fetch_with_context(repo, remote, context)
            .await
            .map_err(legacy_remote_error)
    }

    async fn push(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        if remote != "origin" || refspecs.len() > 1 {
            return Err(GitRemoteError::ProcessFailed {
                exit_code: None,
                summary: "legacy backend supports one refspec on origin".into(),
                stderr_tail: String::new(),
            });
        }
        self.backend
            .push_with_context(
                repo,
                refspecs.first().map(String::as_str).unwrap_or(""),
                context,
            )
            .await
            .map_err(legacy_remote_error)
    }

    async fn delete_remote_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch: &str,
        _context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        self.backend
            .delete_remote_branch(repo, &format!("{remote}/{branch}"))
            .await
            .map_err(legacy_remote_error)
    }

    async fn ls_remote(
        &self,
        _repo: &RepoPath,
        _remote: &str,
        _context: GitOperationContext,
    ) -> Result<Vec<RemoteRef>, GitRemoteError> {
        Err(GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: "ls-remote is unavailable on the legacy adapter".into(),
            stderr_tail: String::new(),
        })
    }
}
