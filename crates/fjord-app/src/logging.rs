//! File logging per the contract in docs/SDD.md §10 (docs/tasks.md P4-14):
//! `tracing` + a rotating file appender in the app data dir, with a small
//! fixed retention, so bug reports can include real diagnostics. Log lines
//! carry paths, repo names, and timings — never file contents or diff
//! bodies (logs may be attached to public bug reports).

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

const MAX_LOG_FILES: usize = 5;

/// Keeps the non-blocking appender's worker thread alive for the app's
/// lifetime; dropped (flushing remaining lines) when Tauri tears down its
/// managed state on exit.
pub struct LogGuard(#[allow(dead_code)] WorkerGuard);

/// Initializes daily-rotating file logging under `<app data dir>/logs`.
/// Returns `None` (leaving the app fully functional, just unlogged) if the
/// appender can't be built or a global subscriber is already set.
pub fn init(app_data_dir: &Path) -> Option<LogGuard> {
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("fjord")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(app_data_dir.join("logs"))
        .ok()?;
    let (writer, guard) = tracing_appender::non_blocking(appender);

    // Default `info`, `debug` for fjord crates in dev builds; overridable
    // via the standard RUST_LOG variable.
    let default_filter = if cfg!(debug_assertions) {
        "info,fjord_app=debug,fjord_services=debug,fjord_git=debug,fjord_db=debug,fjord_fs=debug"
    } else {
        "info"
    };
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init()
        .ok()?;

    Some(LogGuard(guard))
}
