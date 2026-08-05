#![cfg_attr(test, allow(linker_messages))]

//! The only crate allowed to depend on `tauri` (docs/SDD.md §5.1). Owns
//! Tauri command handlers, DI wiring, and app bootstrap. `src-tauri` is a
//! thin entrypoint that just calls [`builder`] and runs it — see
//! docs/tasks.md P0-05.

mod commands;
mod error;
mod ide_launcher;
mod state;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub use error::AppError;
pub use state::AppState;

/// Resolves the app data dir and boots [`AppState`]. Kept separate from the
/// `setup` closure so every failure funnels into one user-facing error path
/// instead of a panic (docs/tasks.md P4-02, SDD §9).
fn initialize(app: &tauri::App) -> Result<AppState, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the application data directory: {e}"))?;

    tauri::async_runtime::block_on(state::bootstrap(&app_data_dir))
        .map_err(|e| format!("could not initialize application state: {e}"))
}

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| match initialize(app) {
            Ok(state) => {
                app.manage(state);
                Ok(())
            }
            Err(message) => {
                tracing::error!(error = %message, "startup failed");
                app.dialog()
                    .message(format!(
                        "Fjord could not start.\n\n{message}\n\nCheck that the application data directory is accessible and not locked by another process."
                    ))
                    .kind(MessageDialogKind::Error)
                    .title("Fjord — startup error")
                    .blocking_show();
                Err(message.into())
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::list_workspaces,
            commands::create_workspace,
            commands::rename_workspace,
            commands::reorder_workspaces,
            commands::delete_workspace,
            commands::list_repositories,
            commands::get_workspace_status,
            commands::refresh_repo_status,
            commands::add_repository,
            commands::import_repositories,
            commands::remove_repository,
            commands::get_branches,
            commands::get_tags,
            commands::get_repo_status,
            commands::get_commit_log,
            commands::global_search,
            commands::get_commit_diff,
            commands::get_file_diff,
            commands::checkout_branch,
            commands::get_working_changes,
            commands::get_working_file_diff,
            commands::create_branch,
            commands::get_stashes,
            commands::stash_push,
            commands::stash_pop,
            commands::open_terminal,
            commands::stage_files,
            commands::unstage_files,
            commands::commit_repo,
            commands::fetch_repo,
            commands::pull_repo,
            commands::push_repo,
            commands::open_merge_tool,
            commands::open_in_ide,
            commands::bulk_fetch,
            commands::bulk_pull,
            commands::bulk_open_in_ide,
        ])
}
