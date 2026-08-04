//! The only crate allowed to depend on `tauri` (docs/SDD.md §5.1). Owns
//! Tauri command handlers, DI wiring, and app bootstrap. `src-tauri` is a
//! thin entrypoint that just calls [`builder`] and runs it — see
//! docs/plan.md P0-05.

mod commands;
mod error;
mod ide_launcher;
mod state;

use tauri::Manager;

pub use error::AppError;
pub use state::AppState;

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir should be resolvable on every supported platform");

            let state = tauri::async_runtime::block_on(state::bootstrap(&app_data_dir))
                .expect("failed to initialize app state");

            app.manage(state);
            Ok(())
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
            commands::remove_repository,
            commands::get_branches,
            commands::get_repo_status,
            commands::get_commit_log,
            commands::get_commit_diff,
            commands::get_file_diff,
            commands::checkout_branch,
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
