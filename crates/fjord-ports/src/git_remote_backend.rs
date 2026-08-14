//! Remote Git transport port. Network operations are deliberately separated
//! from repository-local reads and mutations so the production adapter can use
//! the user's installed Git without leaking process concerns into services.

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use std::path::Path;
use thiserror::Error;

use crate::{GitOperationContext, RepoPath};

#[derive(Debug, Error)]
pub enum GitRemoteError {
    #[error("system Git executable not found")]
    GitExecutableNotFound,
    #[error("failed to start Git process: {0}")]
    SpawnFailed(String),
    #[error("Git authentication is required")]
    AuthenticationRequired { stderr_tail: String },
    #[error("Git authentication failed")]
    AuthenticationFailed { stderr_tail: String },
    #[error("permission denied by remote")]
    PermissionDenied { stderr_tail: String },
    #[error("remote repository not found")]
    RepositoryNotFound { stderr_tail: String },
    #[error("SSH host key verification failed")]
    HostKeyVerificationFailed { stderr_tail: String },
    #[error("SSH key is unavailable")]
    SshKeyUnavailable { stderr_tail: String },
    #[error("certificate validation failed")]
    CertificateFailed { stderr_tail: String },
    #[error("proxy connection failed")]
    ProxyFailed { stderr_tail: String },
    #[error("network is unavailable")]
    NetworkUnavailable { stderr_tail: String },
    #[error("clone destination already exists")]
    CloneDestinationExists { stderr_tail: String },
    #[error("clone destination is invalid")]
    CloneDestinationInvalid { stderr_tail: String },
    #[error("push is not a fast-forward")]
    NonFastForward { stderr_tail: String },
    #[error("force-with-lease failed because the remote ref changed")]
    ForceLeaseFailed { stderr_tail: String },
    #[error("remote rejected the update: {summary}")]
    RemoteRejected {
        summary: String,
        stderr_tail: String,
    },
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
            Self::AuthenticationRequired { .. } => "git_auth_required",
            Self::AuthenticationFailed { .. } => "git_auth_failed",
            Self::PermissionDenied { .. } => "git_permission_denied",
            Self::RepositoryNotFound { .. } => "git_repository_not_found",
            Self::HostKeyVerificationFailed { .. } => "git_host_key_verification_failed",
            Self::SshKeyUnavailable { .. } => "git_ssh_key_unavailable",
            Self::CertificateFailed { .. } => "git_certificate_failed",
            Self::ProxyFailed { .. } => "git_proxy_failed",
            Self::NetworkUnavailable { .. } => "git_network_unavailable",
            Self::CloneDestinationExists { .. } => "clone_destination_exists",
            Self::CloneDestinationInvalid { .. } => "clone_destination_invalid",
            Self::NonFastForward { .. } => "git_non_fast_forward",
            Self::ForceLeaseFailed { .. } => "git_force_lease_failed",
            Self::RemoteRejected { .. } => "git_remote_rejected",
            Self::Timeout => "git_operation_timeout",
            Self::Cancelled => "operation_cancelled",
            Self::ProcessFailed { .. } => "git_remote_error",
        }
    }

    pub fn diagnostics(&self) -> Option<&str> {
        match self {
            Self::AuthenticationRequired { stderr_tail }
            | Self::AuthenticationFailed { stderr_tail }
            | Self::PermissionDenied { stderr_tail }
            | Self::RepositoryNotFound { stderr_tail }
            | Self::HostKeyVerificationFailed { stderr_tail }
            | Self::SshKeyUnavailable { stderr_tail }
            | Self::CertificateFailed { stderr_tail }
            | Self::ProxyFailed { stderr_tail }
            | Self::NetworkUnavailable { stderr_tail }
            | Self::CloneDestinationExists { stderr_tail }
            | Self::CloneDestinationInvalid { stderr_tail }
            | Self::NonFastForward { stderr_tail }
            | Self::ForceLeaseFailed { stderr_tail }
            | Self::RemoteRejected { stderr_tail, .. }
            | Self::ProcessFailed { stderr_tail, .. } => Some(stderr_tail),
            _ => None,
        }
    }
}

#[async_trait]
pub trait GitRemoteBackend: Send + Sync {
    async fn clone_repository(
        &self,
        source_url: &str,
        destination: &Path,
        branch: Option<&str>,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError>;

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

    /// Pushes one exact source object to one exact remote ref using the
    /// explicit expected oid form of force-with-lease.
    async fn force_push_with_lease(
        &self,
        repo: &RepoPath,
        remote: &str,
        source_oid: &str,
        remote_ref: &str,
        expected_oid: &str,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError>;

    /// Pushes a branch that has no upstream yet and records the tracking
    /// configuration. Separate from `push` because publishing is a deliberate
    /// user decision, not a fallback.
    async fn publish_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch_ref: &str,
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
