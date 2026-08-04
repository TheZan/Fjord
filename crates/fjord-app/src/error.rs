use fjord_ports::{GitError, LaunchError, StoreError};
use fjord_services::{RepoError, WorkspaceError};
use serde::Serialize;

/// The only error shape that crosses the Tauri IPC boundary. `code` is
/// stable and localizable (the frontend maps it through the i18n catalog);
/// `message` is a developer-facing fallback, never shown to the user
/// without going through translation first. See docs/SDD.md §8.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        let code = match &err {
            StoreError::WorkspaceNotFound(_) => "workspace_not_found",
            StoreError::RepositoryNotFound(_) => "repository_not_found",
            StoreError::Database(_) => "database_error",
        };
        AppError {
            code: code.to_string(),
            message: err.to_string(),
        }
    }
}

impl From<WorkspaceError> for AppError {
    fn from(err: WorkspaceError) -> Self {
        match err {
            WorkspaceError::Store(inner) => inner.into(),
            WorkspaceError::NotAGitRepository(_) => AppError {
                code: "not_a_git_repository".to_string(),
                message: err.to_string(),
            },
            WorkspaceError::Git(_) => AppError {
                code: "git_error".to_string(),
                message: err.to_string(),
            },
        }
    }
}

impl From<fjord_fs::DiscoveryError> for AppError {
    fn from(err: fjord_fs::DiscoveryError) -> Self {
        AppError {
            code: "repository_discovery_failed".to_string(),
            message: err.to_string(),
        }
    }
}

impl From<RepoError> for AppError {
    fn from(err: RepoError) -> Self {
        match err {
            RepoError::Store(inner) => inner.into(),
            RepoError::Git(inner) => git_error_to_app_error(inner),
            RepoError::Launch(inner) => launch_error_to_app_error(inner),
        }
    }
}

fn launch_error_to_app_error(err: LaunchError) -> AppError {
    let code = match &err {
        LaunchError::NoIdeAvailable => "no_ide_available",
        LaunchError::SpawnFailed(_) => "ide_launch_failed",
    };

    AppError {
        code: code.to_string(),
        message: err.to_string(),
    }
}

fn git_error_to_app_error(err: GitError) -> AppError {
    let code = match &err {
        GitError::RepoNotFound(_) => "repository_not_found",
        GitError::NotAGitRepository(_) => "not_a_git_repository",
        GitError::Conflict { .. } => "merge_conflict",
        GitError::AuthenticationFailed => "auth_failed",
        GitError::NoUpstream => "no_upstream",
        GitError::NothingToCommit => "nothing_to_commit",
        GitError::NoConflicts => "no_conflicts",
        GitError::MergeToolFailed(_) => "merge_tool_failed",
        GitError::NotImplemented(_) | GitError::Gix(_) | GitError::Git2(_) => "git_error",
    };

    AppError {
        code: code.to_string(),
        message: err.to_string(),
    }
}
