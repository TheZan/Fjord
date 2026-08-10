use std::path::PathBuf;

use crate::error::AppError;
use crate::interaction_traces::TracedState;
use fjord_domain::{GitEnvironmentInfo, Settings};

#[tauri::command]
pub async fn get_settings(state: TracedState<'_>) -> Result<Settings, AppError> {
    Ok(state.settings.get_settings().await?)
}

#[tauri::command]
pub async fn update_settings(
    state: TracedState<'_>,
    settings: Settings,
) -> Result<Settings, AppError> {
    let updated = state.settings.update_settings(settings).await?;
    state
        .interaction_traces
        .set_enabled(updated.performance_diagnostics);
    Ok(updated)
}

/// Sidecar resolution is a Tauri-resource concern, so `fjord-services` cannot
/// answer it. The command layer owns the answer and stamps it onto the
/// inspection result every environment command returns — the alternative,
/// leaving it `false` on some paths, would report a missing askpass to a user
/// whose askpass is fine (docs/tasks.md P5-21).
fn with_askpass_availability(available: bool, mut info: GitEnvironmentInfo) -> GitEnvironmentInfo {
    info.askpass_available = available;
    info
}

#[tauri::command]
pub async fn get_git_environment(state: TracedState<'_>) -> Result<GitEnvironmentInfo, AppError> {
    let info = state.repos.get_git_environment().await?;
    Ok(with_askpass_availability(state.askpass_available(), info))
}

#[tauri::command]
pub async fn select_git_executable(
    state: TracedState<'_>,
    path: PathBuf,
) -> Result<GitEnvironmentInfo, AppError> {
    let info = state.repos.set_git_executable_path(path).await?;
    Ok(with_askpass_availability(state.askpass_available(), info))
}

#[tauri::command]
pub async fn reset_git_executable(state: TracedState<'_>) -> Result<GitEnvironmentInfo, AppError> {
    let info = state.repos.reset_git_executable_path().await?;
    Ok(with_askpass_availability(state.askpass_available(), info))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspected() -> GitEnvironmentInfo {
        GitEnvironmentInfo {
            executable_path: Some(PathBuf::from("git")),
            version: Some("2.51.0".into()),
            executable_source: None,
            configured_path_valid: true,
            credential_helpers: vec![],
            ssh_command: None,
            ssh_agent_available: false,
            proxy_configured: false,
            // What `fjord-git` always produces: the adapter cannot know.
            askpass_available: false,
        }
    }

    #[test]
    fn availability_comes_from_the_application_not_the_git_adapter() {
        assert!(with_askpass_availability(true, inspected()).askpass_available);
        assert!(!with_askpass_availability(false, inspected()).askpass_available);
    }
}
