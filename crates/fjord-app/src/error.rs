use fjord_ports::{GitEnvironmentError, GitError, GitRemoteError, LaunchError, StoreError};
use fjord_services::{RepoError, WorkspaceError};
use serde::Serialize;

/// The only error shape that crosses the Tauri IPC boundary. `code` is
/// stable and localizable; `message` is a developer-facing fallback and
/// `diagnostics` contains only sanitized remote output.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<String>,
}

impl AppError {
    fn new(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            message,
            diagnostics: None,
        }
    }

    pub fn operation_cancelled() -> Self {
        Self::new("operation_cancelled", "operation cancelled".to_string())
    }

    pub fn performance_diagnostics_disabled() -> Self {
        Self::new(
            "performance_diagnostics_disabled",
            "performance diagnostics are disabled".to_string(),
        )
    }
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        let code = match &err {
            StoreError::WorkspaceNotFound(_) => "workspace_not_found",
            StoreError::RepositoryNotFound(_) => "repository_not_found",
            StoreError::RepositoryAlreadyExists(_) => "repository_already_added",
            StoreError::Database(_) => "database_error",
        };
        Self::new(code, err.to_string())
    }
}

impl From<WorkspaceError> for AppError {
    fn from(err: WorkspaceError) -> Self {
        match err {
            WorkspaceError::Store(inner) => inner.into(),
            error @ WorkspaceError::NotAGitRepository(_) => {
                Self::new("not_a_git_repository", error.to_string())
            }
            error @ WorkspaceError::RepositoryAlreadyAdded(_) => {
                Self::new("repository_already_added", error.to_string())
            }
            WorkspaceError::Git(inner) => git_error_to_app_error(inner),
        }
    }
}

impl From<fjord_fs::DiscoveryError> for AppError {
    fn from(err: fjord_fs::DiscoveryError) -> Self {
        Self::new("repository_discovery_failed", err.to_string())
    }
}

impl From<RepoError> for AppError {
    fn from(err: RepoError) -> Self {
        match err {
            RepoError::Store(inner) => inner.into(),
            RepoError::Git(inner) => git_error_to_app_error(inner),
            RepoError::Remote(inner) => remote_error_to_app_error(inner),
            RepoError::Environment(inner) => environment_error_to_app_error(inner),
            RepoError::Launch(inner) => launch_error_to_app_error(inner),
            error @ RepoError::SnapshotChangedDuringCapture => {
                Self::new("snapshot_changed_during_capture", error.to_string())
            }
            error @ RepoError::DiffWindowTooLarge { .. } => {
                Self::new("diff_window_too_large", error.to_string())
            }
        }
    }
}

fn environment_error_to_app_error(err: GitEnvironmentError) -> AppError {
    AppError::new(err.code(), err.to_string())
}

fn launch_error_to_app_error(err: LaunchError) -> AppError {
    let code = match &err {
        LaunchError::NoIdeAvailable => "no_ide_available",
        LaunchError::IdeNotAllowed(_) => "ide_not_allowed",
        LaunchError::NoTerminalAvailable => "no_terminal_available",
        LaunchError::SpawnFailed(_) => "ide_launch_failed",
    };
    AppError::new(code, err.to_string())
}

fn git_error_to_app_error(err: GitError) -> AppError {
    let code = match &err {
        GitError::RepoNotFound(_) => "repository_not_found",
        GitError::NotAGitRepository(_) => "not_a_git_repository",
        GitError::RepositoryOwnership(_) => "git_repository_ownership",
        // The same code remote transport reports, so the frontend cannot end up
        // treating "no usable Git" as two unrelated failures (P5-20).
        GitError::ExecutableNotFound => "git_executable_not_found",
        GitError::Conflict { .. } => "merge_conflict",
        GitError::AuthenticationFailed => "auth_failed",
        GitError::NoUpstream => "no_upstream",
        GitError::NothingToCommit => "nothing_to_commit",
        GitError::NoConflicts => "no_conflicts",
        GitError::BranchExists(_) => "branch_exists",
        GitError::NothingToStash => "nothing_to_stash",
        GitError::StashEmpty => "stash_empty",
        GitError::MergeToolFailed(_) => "merge_tool_failed",
        GitError::Cancelled => "operation_cancelled",
        GitError::NotImplemented(_) | GitError::Gix(_) | GitError::Git2(_) => "git_error",
    };
    AppError::new(code, err.to_string())
}

fn remote_error_to_app_error(err: GitRemoteError) -> AppError {
    AppError {
        code: err.code().to_string(),
        message: err.to_string(),
        diagnostics: err.diagnostics().map(ToString::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn duplicate_repository_has_a_stable_localizable_code() {
        let error: AppError =
            WorkspaceError::RepositoryAlreadyAdded(PathBuf::from("C:/repos/fjord")).into();

        assert_eq!(error.code, "repository_already_added");
        assert!(error.message.contains("C:/repos/fjord"));
    }

    #[test]
    fn remote_diagnostics_cross_the_boundary_sanitized() {
        let error = remote_error_to_app_error(GitRemoteError::AuthenticationFailed {
            stderr_tail: "fatal: Authentication failed for https://[REDACTED]@example.test".into(),
        });
        assert_eq!(error.code, "git_auth_failed");
        assert!(error.diagnostics.unwrap().contains("[REDACTED]"));
    }

    #[test]
    fn repository_ownership_has_the_same_stable_code_through_both_services() {
        let repo_error: AppError =
            RepoError::Git(GitError::RepositoryOwnership("not owned".into())).into();
        let workspace_error: AppError =
            WorkspaceError::Git(GitError::RepositoryOwnership("not owned".into())).into();

        assert_eq!(repo_error.code, "git_repository_ownership");
        assert_eq!(workspace_error.code, "git_repository_ownership");
    }
}
