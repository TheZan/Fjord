//! `fjord-db`: the only crate that knows SQLite exists. Implements the
//! `SettingsStore` / `WorkspaceStore` ports from `fjord-ports` — see
//! docs/specs/data-model.md for the schema this is built on.
//!
//! Queries are runtime-checked (`sqlx::query`/`query_as`) rather than the
//! compile-time `query!` macros for now, to avoid requiring a live
//! `DATABASE_URL` or a checked-in `.sqlx` offline cache just to build the
//! Phase 0 skeleton. Worth revisiting once the schema stabilizes.

mod pool;
mod settings_store;
mod ui_state_store;
mod workspace_store;

pub use pool::{connect, DbError};
pub use settings_store::SqliteSettingsStore;
pub use ui_state_store::SqliteUiStateStore;
pub use workspace_store::SqliteWorkspaceStore;
