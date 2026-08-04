use fjord_ports::StoreError;
use fjord_services::WorkspaceError;
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
