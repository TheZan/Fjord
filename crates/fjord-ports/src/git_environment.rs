use std::path::Path;

use async_trait::async_trait;
use fjord_domain::{GitConnectionTestResult, GitEnvironmentInfo};
use thiserror::Error;

use crate::{GitOperationContext, GitRemoteError, RepoPath};

#[derive(Debug, Error)]
pub enum GitEnvironmentError {
    #[error("system Git executable not found")]
    GitExecutableNotFound,
    #[error("configured Git executable is invalid")]
    InvalidConfiguredPath,
    #[error("Git environment inspection failed: {0}")]
    InspectionFailed(String),
}

impl GitEnvironmentError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::GitExecutableNotFound => "git_executable_not_found",
            Self::InvalidConfiguredPath => "git_executable_invalid",
            Self::InspectionFailed(_) => "git_environment_error",
        }
    }
}

#[async_trait]
pub trait GitEnvironmentProvider: Send + Sync {
    async fn inspect(
        &self,
        configured_path: Option<&Path>,
    ) -> Result<GitEnvironmentInfo, GitEnvironmentError>;

    async fn test_connection(
        &self,
        repo: &RepoPath,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<GitConnectionTestResult, GitRemoteError>;
}
