use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

use crate::error::AppError;
use crate::interaction_traces::TracedState;
use fjord_domain::{GitEnvironmentInfo, Settings, UiState, UiStatePatch};

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

#[tauri::command]
pub async fn get_ui_state(state: TracedState<'_>) -> Result<UiState, AppError> {
    Ok(state.ui_state.get_ui_state().await?)
}

#[tauri::command]
pub async fn update_ui_state(
    state: TracedState<'_>,
    patch: UiStatePatch,
) -> Result<UiState, AppError> {
    Ok(state.ui_state.update_ui_state(patch).await?)
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

// Tauri serializes the stable AppError IPC payload by value; boxing it would
// change the generated command contract for a user-triggered settings action.
#[allow(clippy::result_large_err)]
#[tauri::command]
pub fn reveal_log_folder(app: tauri::AppHandle) -> Result<(), AppError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::log_folder(format!("could not resolve log folder: {error}")))?
        .join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| AppError::log_folder(format!("could not create log folder: {error}")))?;
    spawn_reveal_command(&directory)
        .map_err(|error| AppError::log_folder(format!("could not reveal log folder: {error}")))?;
    Ok(())
}

fn spawn_reveal_command(directory: &Path) -> std::io::Result<()> {
    let mut command = reveal_command(directory);
    command.spawn().map(|_| ())
}

fn reveal_command(directory: &Path) -> Command {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command.arg(directory);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

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

    #[test]
    fn reveal_command_uses_the_platform_folder_opener_without_a_shell() {
        let directory = Path::new("logs");
        let command = reveal_command(directory);
        #[cfg(target_os = "windows")]
        assert_eq!(command.get_program(), OsStr::new("explorer.exe"));
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_program(), OsStr::new("open"));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(command.get_program(), OsStr::new("xdg-open"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("logs")]
        );
    }
}
