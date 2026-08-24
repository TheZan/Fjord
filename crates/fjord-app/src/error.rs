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
    pub diagnostics: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Box<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash_ref: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<Box<String>>,
}

fn boxed<T>(value: T) -> Option<Box<T>> {
    Some(Box::new(value))
}

impl AppError {
    fn new(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            message,
            diagnostics: None,
            paths: None,
            stash_ref: None,
            tool: None,
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

    pub fn log_folder(message: String) -> Self {
        Self::new("log_folder_unavailable", message)
    }

    pub fn patch_export_failed(message: String) -> Self {
        Self::new("patch_export_failed", message)
    }
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        let code = match &err {
            StoreError::WorkspaceNotFound(_) => "workspace_not_found",
            StoreError::RepositoryNotFound(_) => "repository_not_found",
            StoreError::RepositoryAlreadyExists(_) => "repository_already_added",
            StoreError::Database(_) => "database_error",
            StoreError::InvalidSetting(code) => *code,
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
            error @ RepoError::PreflightChangedDuringCapture => {
                Self::new("preflight_changed_during_capture", error.to_string())
            }
            error @ RepoError::DiffWindowTooLarge { .. } => {
                Self::new("diff_window_too_large", error.to_string())
            }
            error @ RepoError::InvalidCloneRequest(_) => {
                Self::new("clone_request_invalid", error.to_string())
            }
            error @ RepoError::CloneDestinationInvalid(_) => {
                Self::new("clone_destination_invalid", error.to_string())
            }
            error @ RepoError::CloneDestinationExists => {
                Self::new("clone_destination_exists", error.to_string())
            }
            error @ RepoError::CloneRegistrationFailed(_) => {
                Self::new("clone_registration_failed", error.to_string())
            }
            error @ RepoError::InvalidCreateRepositoryRequest(_) => {
                Self::new("create_repository_request_invalid", error.to_string())
            }
            error @ RepoError::CreateRepositoryDestinationInvalid(_) => {
                Self::new("create_repository_destination_invalid", error.to_string())
            }
            error @ RepoError::CreateRepositoryDestinationNotEmpty => {
                Self::new("create_repository_destination_not_empty", error.to_string())
            }
            error @ RepoError::CreateRepositoryRegistrationFailed(_) => {
                Self::new("create_repository_registration_failed", error.to_string())
            }
            error @ RepoError::PathOutsideRepository(_) => {
                Self::new("path_outside_repository", error.to_string())
            }
            error @ RepoError::PathNotFound(_) => Self::new("path_not_found", error.to_string()),
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
    let err = match err {
        GitError::OperationStepFailed(diagnostics) => {
            return AppError {
                code: "operation_step_failed".to_string(),
                message: "repository operation step failed".to_string(),
                diagnostics: boxed(diagnostics),
                paths: None,
                stash_ref: None,
                tool: None,
            };
        }
        GitError::CheckoutWouldOverwrite { paths } => {
            return AppError {
                code: "checkout_would_overwrite".to_string(),
                message: "checkout would overwrite local changes".to_string(),
                diagnostics: None,
                paths: boxed(paths),
                stash_ref: None,
                tool: None,
            };
        }
        GitError::MergeWouldOverwrite { paths } => {
            return AppError {
                code: "merge_would_overwrite".to_string(),
                message: "merge would overwrite local changes".to_string(),
                diagnostics: None,
                paths: boxed(paths),
                stash_ref: None,
                tool: None,
            };
        }
        GitError::StashScopeUnrepresentable { path } => {
            return AppError {
                code: "stash_scope_unrepresentable".to_string(),
                message: "the selected stash scope cannot be represented exactly".to_string(),
                diagnostics: None,
                paths: boxed(vec![path]),
                stash_ref: None,
                tool: None,
            };
        }
        GitError::MergeFailed(diagnostics) => {
            return AppError {
                code: "merge_failed".to_string(),
                message: "merge failed".to_string(),
                diagnostics: boxed(diagnostics),
                paths: None,
                stash_ref: None,
                tool: None,
            };
        }
        GitError::MergeStashRetained(source) => {
            let mut error = git_error_to_app_error(*source);
            error.stash_ref = boxed("stash@{0}".to_string());
            return error;
        }
        GitError::DiffToolNotConfigured { tool } => {
            return AppError {
                code: "diff_tool_not_configured".to_string(),
                message: format!("Git could not resolve the difftool {tool}"),
                diagnostics: None,
                paths: None,
                stash_ref: None,
                tool: boxed(tool),
            };
        }
        other => other,
    };
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
        GitError::InvalidRepositoryInitialization(_) => "create_repository_request_invalid",
        GitError::RepositoryDestinationInvalid(_) => "create_repository_destination_invalid",
        GitError::RepositoryDestinationNotEmpty => "create_repository_destination_not_empty",
        GitError::RemoteAlreadyExists(_) => "remote_name_exists",
        GitError::InvalidRemote(_) => "remote_request_invalid",
        GitError::NothingToStash => "nothing_to_stash",
        GitError::StashEmpty => "stash_empty",
        GitError::StashNotFound => "stash_not_found",
        GitError::StashAmbiguous => "stash_ambiguous",
        GitError::CheckoutWouldOverwrite { .. } => unreachable!("handled above"),
        GitError::MergeSourceNotFound => "merge_source_not_found",
        GitError::MergeSourceIsCurrentBranch => "merge_source_is_current_branch",
        GitError::MergeSourceUnsupported => "merge_source_unsupported",
        GitError::MergeNotFastForward => "merge_not_fast_forward",
        GitError::MergeWouldOverwrite { .. } => unreachable!("handled above"),
        GitError::MergeIndexHasStagedChanges => "merge_index_has_staged_changes",
        GitError::MergeDetachedHead => "merge_detached_head",
        GitError::MergeUnbornHead => "merge_unborn_head",
        GitError::OperationAlreadyInProgress => "operation_already_in_progress",
        GitError::MergeFailed(_) => unreachable!("handled above"),
        GitError::MergeStashRetained(_) => unreachable!("handled above"),
        GitError::MergeToolFailed(_) => "merge_tool_failed",
        GitError::Cancelled => "operation_cancelled",
        GitError::OperationNotInProgress => "operation_not_in_progress",
        GitError::OperationHasConflicts { .. } => "operation_has_conflicts",
        GitError::OperationStepFailed(_) => unreachable!("handled above"),
        GitError::PatchStale => "patch_stale",
        GitError::PreflightStale => "preflight_stale",
        GitError::PatchApplyFailed(_) => "patch_apply_failed",
        GitError::PatchUnsupported(_) => "patch_unsupported",
        GitError::IgnoreRuleUnsupportedForTrackedFile(_) => {
            "ignore_rule_unsupported_for_tracked_file"
        }
        GitError::IgnoreFileEncodingUnsupported => "ignore_file_encoding_unsupported",
        GitError::IgnoreWriteFailed(_) => "ignore_write_failed",
        GitError::DeleteTargetNotAFile => "delete_target_not_a_file",
        GitError::DeleteFilePartiallyStaged { .. } => "delete_file_partially_staged",
        GitError::DeleteFileConflicted { .. } => "delete_file_conflicted",
        GitError::DiffToolNotConfigured { .. } => unreachable!("handled above"),
        GitError::DiffToolNameInvalid => "diff_tool_name_invalid",
        GitError::StashFileUnsupportedGit => "stash_file_unsupported_git",
        GitError::StashFileConflicted { .. } => "stash_file_conflicted",
        GitError::StashScopeEmpty => "stash_scope_empty",
        GitError::StashScopeUnrepresentable { .. } => unreachable!("handled above"),
        GitError::NotImplemented(_) | GitError::Gix(_) | GitError::Git2(_) => "git_error",
    };
    AppError::new(code, err.to_string())
}

fn remote_error_to_app_error(err: GitRemoteError) -> AppError {
    AppError {
        code: err.code().to_string(),
        message: err.to_string(),
        diagnostics: err.diagnostics().map(ToString::to_string).map(Box::new),
        paths: None,
        stash_ref: None,
        tool: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
        assert!(error
            .diagnostics
            .as_deref()
            .is_some_and(|diagnostics| diagnostics.contains("[REDACTED]")));
    }

    #[test]
    fn clone_failures_have_stable_codes() {
        assert_eq!(
            AppError::from(RepoError::InvalidCloneRequest("missing URL".into())).code,
            "clone_request_invalid"
        );
        assert_eq!(
            AppError::from(RepoError::CloneDestinationInvalid("missing parent".into())).code,
            "clone_destination_invalid"
        );
        assert_eq!(
            AppError::from(RepoError::CloneDestinationExists).code,
            "clone_destination_exists"
        );
        assert_eq!(
            AppError::from(RepoError::CloneRegistrationFailed(
                "workspace removed".into()
            ))
            .code,
            "clone_registration_failed"
        );
    }

    #[test]
    fn create_repository_failures_have_stable_codes() {
        assert_eq!(
            AppError::from(RepoError::InvalidCreateRepositoryRequest("bad name".into())).code,
            "create_repository_request_invalid"
        );
        assert_eq!(
            AppError::from(RepoError::CreateRepositoryDestinationInvalid(
                "missing parent".into()
            ))
            .code,
            "create_repository_destination_invalid"
        );
        assert_eq!(
            AppError::from(RepoError::CreateRepositoryDestinationNotEmpty).code,
            "create_repository_destination_not_empty"
        );
        assert_eq!(
            AppError::from(RepoError::CreateRepositoryRegistrationFailed(
                "workspace removed".into()
            ))
            .code,
            "create_repository_registration_failed"
        );
        assert_eq!(
            git_error_to_app_error(GitError::InvalidRepositoryInitialization(
                "bad branch".into()
            ))
            .code,
            "create_repository_request_invalid"
        );
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

    #[test]
    fn patch_failures_have_distinct_stable_codes() {
        let stale = git_error_to_app_error(GitError::PatchStale);
        let preflight_stale = git_error_to_app_error(GitError::PreflightStale);
        let apply = git_error_to_app_error(GitError::PatchApplyFailed("rejected".into()));
        let unsupported = git_error_to_app_error(GitError::PatchUnsupported("binary".into()));

        assert_eq!(stale.code, "patch_stale");
        assert_eq!(preflight_stale.code, "preflight_stale");
        assert_eq!(apply.code, "patch_apply_failed");
        assert_eq!(unsupported.code, "patch_unsupported");
    }

    #[test]
    fn ignore_failures_have_distinct_stable_codes() {
        assert_eq!(
            git_error_to_app_error(GitError::IgnoreRuleUnsupportedForTrackedFile(
                "tracked.txt".into(),
            ))
            .code,
            "ignore_rule_unsupported_for_tracked_file",
        );
        assert_eq!(
            git_error_to_app_error(GitError::IgnoreFileEncodingUnsupported).code,
            "ignore_file_encoding_unsupported",
        );
        assert_eq!(
            git_error_to_app_error(GitError::IgnoreWriteFailed("locked".into())).code,
            "ignore_write_failed",
        );
    }

    #[test]
    fn invalid_diff_tool_name_has_the_settings_error_code() {
        assert_eq!(
            git_error_to_app_error(GitError::DiffToolNameInvalid).code,
            "diff_tool_name_invalid"
        );
    }

    #[test]
    fn checkout_overwrite_error_exposes_paths() {
        let error = git_error_to_app_error(GitError::CheckoutWouldOverwrite {
            paths: vec!["src/main.rs".into(), "README.md".into()],
        });

        assert_eq!(error.code, "checkout_would_overwrite");
        assert_eq!(
            error.paths.as_deref(),
            Some(&vec!["src/main.rs".into(), "README.md".into()])
        );
    }

    #[test]
    fn repository_operation_failures_have_distinct_stable_codes() {
        assert_eq!(
            git_error_to_app_error(GitError::OperationNotInProgress).code,
            "operation_not_in_progress"
        );
        assert_eq!(
            git_error_to_app_error(GitError::OperationHasConflicts {
                paths: vec!["src/main.rs".into()],
            })
            .code,
            "operation_has_conflicts"
        );
        assert_eq!(
            git_error_to_app_error(GitError::OperationStepFailed("failed".into())).code,
            "operation_step_failed"
        );
        let error = git_error_to_app_error(GitError::OperationStepFailed("sanitized".into()));
        assert_eq!(
            error
                .diagnostics
                .as_deref()
                .map(|diagnostics| diagnostics.as_str()),
            Some("sanitized")
        );
    }

    #[test]
    fn repository_file_failures_have_stable_codes() {
        assert_eq!(
            AppError::from(RepoError::PathOutsideRepository("../secret".into())).code,
            "path_outside_repository"
        );
        assert_eq!(
            AppError::from(RepoError::PathNotFound("missing.txt".into())).code,
            "path_not_found"
        );
    }

    #[test]
    fn stash_identity_failures_have_stable_codes() {
        assert_eq!(
            git_error_to_app_error(GitError::StashNotFound).code,
            "stash_not_found"
        );
        assert_eq!(
            git_error_to_app_error(GitError::StashAmbiguous).code,
            "stash_ambiguous"
        );
        assert_eq!(
            git_error_to_app_error(GitError::StashScopeEmpty).code,
            "stash_scope_empty"
        );
        let unrepresentable = git_error_to_app_error(GitError::StashScopeUnrepresentable {
            path: "file.txt".into(),
        });
        assert_eq!(unrepresentable.code, "stash_scope_unrepresentable");
        assert_eq!(
            unrepresentable.paths.as_deref(),
            Some(&vec!["file.txt".to_string()])
        );
    }

    #[test]
    fn merge_errors_report_a_retained_stash_without_changing_the_stable_code() {
        let error = git_error_to_app_error(GitError::MergeStashRetained(Box::new(
            GitError::MergeNotFastForward,
        )));

        assert_eq!(error.code, "merge_not_fast_forward");
        assert_eq!(
            error.stash_ref.as_deref().map(|stash| stash.as_str()),
            Some("stash@{0}")
        );
    }

    #[test]
    fn serialization_omits_absent_optional_payloads() {
        let value =
            serde_json::to_value(AppError::new("test_code", "fallback".to_string())).unwrap();

        assert_eq!(
            value,
            json!({
                "code": "test_code",
                "message": "fallback"
            })
        );
    }

    #[test]
    fn serialization_keeps_optional_payloads_at_the_top_level() {
        let value = serde_json::to_value(AppError {
            code: "test_code".to_string(),
            message: "fallback".to_string(),
            diagnostics: boxed("sanitized diagnostics".to_string()),
            paths: boxed(vec!["src/main.rs".to_string(), "README.md".to_string()]),
            stash_ref: boxed("stash@{0}".to_string()),
            tool: boxed("meld".to_string()),
        })
        .unwrap();

        assert_eq!(
            value,
            json!({
                "code": "test_code",
                "message": "fallback",
                "diagnostics": "sanitized diagnostics",
                "paths": ["src/main.rs", "README.md"],
                "stash_ref": "stash@{0}",
                "tool": "meld"
            })
        );
    }

    #[test]
    fn app_error_stays_below_the_project_size_ceiling() {
        let size = std::mem::size_of::<AppError>();
        assert!(size <= 96, "AppError grew to {size} bytes");
    }
}
