//! Remote Git transport port. Network operations are deliberately separated
//! from repository-local reads and mutations so the production adapter can use
//! the user's installed Git without leaking process concerns into services.

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use thiserror::Error;

use crate::{GitOperationContext, RepoPath};

#[derive(Debug, Error)]
pub enum GitRemoteError {
    #[error("system Git executable not found")]
    GitExecutableNotFound,
    #[error("failed to start Git process: {0}")]
    SpawnFailed(String),
    #[error("Git authentication is required")]
    AuthenticationRequired,
    #[error("Git authentication failed")]
    AuthenticationFailed,
    #[error("permission denied by remote")]
    PermissionDenied,
    #[error("remote repository not found")]
    RepositoryNotFound,
    #[error("SSH host key verification failed")]
    HostKeyVerificationFailed,
    #[error("SSH key is unavailable")]
    SshKeyUnavailable,
    #[error("certificate validation failed")]
    CertificateFailed,
    #[error("proxy connection failed")]
    ProxyFailed,
    #[error("network is unavailable")]
    NetworkUnavailable,
    #[error("push is not a fast-forward")]
    NonFastForward,
    #[error("remote rejected the update: {0}")]
    RemoteRejected(String),
    #[error("Git operation timed out")]
    Timeout,
    #[error("operation cancelled")]
    Cancelled,
    #[error("Git process failed (exit code {exit_code:?}): {summary}")]
    ProcessFailed {
        exit_code: Option<i32>,
        summary: String,
        stderr_tail: String,
    },
}

impl GitRemoteError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::GitExecutableNotFound => "git_executable_not_found",
            Self::SpawnFailed(_) => "git_process_spawn_failed",
            Self::AuthenticationRequired => "git_auth_required",
            Self::AuthenticationFailed => "git_auth_failed",
            Self::PermissionDenied => "git_permission_denied",
            Self::RepositoryNotFound => "git_repository_not_found",
            Self::HostKeyVerificationFailed => "git_host_key_verification_failed",
            Self::SshKeyUnavailable => "git_ssh_key_unavailable",
            Self::CertificateFailed => "git_certificate_failed",
            Self::ProxyFailed => "git_proxy_failed",
            Self::NetworkUnavailable => "git_network_unavailable",
            Self::NonFastForward => "git_non_fast_forward",
            Self::RemoteRejected(_) => "git_remote_rejected",
            Self::Timeout => "git_operation_timeout",
            Self::Cancelled => "operation_cancelled",
            Self::ProcessFailed { .. } => "git_remote_error",
        }
    }

    pub fn diagnostics(&self) -> Option<&str> {
        match self {
            Self::ProcessFailed { stderr_tail, .. } => Some(stderr_tail),
            _ => None,
        }
    }
}

#[async_trait]
pub trait GitRemoteBackend: Send + Sync {
    async fn fetch(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError>;

    async fn push(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError>;

    async fn delete_remote_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch: &str,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError>;

    async fn ls_remote(
        &self,
        repo: &RepoPath,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<Vec<RemoteRef>, GitRemoteError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_error_codes_are_stable() {
        assert_eq!(
            GitRemoteError::GitExecutableNotFound.code(),
            "git_executable_not_found"
        );
        assert_eq!(GitRemoteError::Cancelled.code(), "operation_cancelled");
        assert_eq!(
            GitRemoteError::ProcessFailed {
                exit_code: Some(1),
                summary: "failed".into(),
                stderr_tail: "details".into(),
            }
            .code(),
            "git_remote_error"
        );
    }
}
