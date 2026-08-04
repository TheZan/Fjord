//! The only crate allowed to depend on `tauri` (docs/SDD.md §5.1). Owns
//! Tauri command handlers, DI wiring, and app bootstrap. `src-tauri` is a
//! thin entrypoint that just calls [`builder`] and runs it — see
//! docs/plan.md P0-05.

mod commands;
mod error;
mod state;

use tauri::Manager;

pub use error::AppError;
pub use state::AppState;

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
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
        ])
}
