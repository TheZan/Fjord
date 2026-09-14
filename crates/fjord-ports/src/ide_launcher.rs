//! `IdeLauncher` port. One implementation per OS lives in `fjord-app` — see
//! docs/SDD.md §5.4. `fjord-services` issues a single `open` call and never
//! branches on target OS.

use async_trait::async_trait;
use fjord_domain::OpenTarget;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LaunchError {
    #[error("no IDE configured and none could be auto-detected")]
    NoIdeAvailable,
    #[error("'{0}' is not a known IDE; use the 'custom:<command>' form to launch a custom editor")]
    IdeNotAllowed(String),
    #[error("no terminal emulator could be found")]
    NoTerminalAvailable,
    #[error("failed to launch: {0}")]
    SpawnFailed(String),
}

#[async_trait]
pub trait IdeLauncher: Send + Sync {
    /// Opens `path` in `ide` if given, otherwise the user's configured
    /// default (or a sensible auto-detected fallback).
    async fn open(&self, path: &Path, ide: Option<&str>) -> Result<(), LaunchError>;

    /// Opens one validated repository file. `line` is intentionally part of
    /// the port even though the first caller does not request line navigation.
    async fn open_path(
        &self,
        path: &Path,
        target: OpenTarget,
        ide: Option<&str>,
    ) -> Result<(), LaunchError> {
        match target {
            OpenTarget::ConfiguredEditor { .. } => self.open(path, ide).await,
            OpenTarget::DefaultApplication => Err(LaunchError::SpawnFailed(
                "opening with the default application is unavailable".into(),
            )),
        }
    }

    /// Reveals one validated repository file in the platform file manager.
    async fn reveal_path(&self, _path: &Path) -> Result<(), LaunchError> {
        Err(LaunchError::SpawnFailed(
            "revealing a file is unavailable".into(),
        ))
    }

    /// Opens the OS terminal emulator with `path` as its working directory —
    /// the "Open terminal here" case SDD §5.4 names as belonging to this port
    /// rather than to `GitBackend` (it isn't a Git operation).
    async fn open_terminal(&self, path: &Path) -> Result<(), LaunchError>;
}
