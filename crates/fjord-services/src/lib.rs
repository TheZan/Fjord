//! Use-cases / application logic. Depends only on `fjord-domain` and
//! `fjord-ports` — never on `tauri`, `sqlx`, or a Git engine directly.
//! See docs/SDD.md §5.1.

mod repo_service;
mod settings_service;
mod ui_state_service;
mod workspace_service;

pub use repo_service::{RepoError, RepoService};
pub use settings_service::SettingsService;
pub use ui_state_service::UiStateService;
pub use workspace_service::{WorkspaceError, WorkspaceService};
