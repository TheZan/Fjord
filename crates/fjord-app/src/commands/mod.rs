//! See docs/specs/ipc-commands.md — command names, request/response shapes,
//! and the `verb_noun` naming convention are the actual frontend/backend
//! contract, not just this module's local style. Each handler stays a thin
//! adapter over a service call (SDD §5.1) — no logic lives here.

mod auth;
mod diagnostics;
mod repo;
mod settings;
mod workspace;

// Glob re-exports, not named ones: `#[tauri::command]` also generates
// hidden sibling items (`__cmd__*`) that `tauri::generate_handler!` needs
// to find alongside each function — a named `pub use` only re-exports the
// function itself and silently breaks the macro lookup.
pub use auth::*;
pub use diagnostics::*;
pub use repo::*;
pub use settings::*;
pub use workspace::*;
