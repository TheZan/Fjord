//! Use-cases / application logic. Depends only on `fjord-domain` and
//! `fjord-ports` — never on `tauri`, `sqlx`, or a Git engine directly.
//! See docs/SDD.md §5.1.

mod settings_service;

pub use settings_service::SettingsService;
