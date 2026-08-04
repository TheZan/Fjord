//! `IdeLauncher` port. One implementation per OS lives in `fjord-app` — see
//! docs/SDD.md §5.4. `fjord-services` issues a single `open` call and never
//! branches on target OS.

use async_trait::async_trait;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LaunchError {
    #[error("no IDE configured and none could be auto-detected")]
    NoIdeAvailable,
    #[error("failed to launch: {0}")]
    SpawnFailed(String),
}

#[async_trait]
pub trait IdeLauncher: Send + Sync {
    /// Opens `path` in `ide` if given, otherwise the user's configured
    /// default (or a sensible auto-detected fallback).
    async fn open(&self, path: &Path, ide: Option<&str>) -> Result<(), LaunchError>;
}
