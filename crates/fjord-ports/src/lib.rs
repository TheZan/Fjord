//! Port traits: what `fjord-services` needs from the outside world, as
//! interfaces only. See docs/SDD.md §5.1 — this is the crate boundary that
//! makes the Git engine, the database, and OS integration swappable.

mod git_backend;
mod ide_launcher;
mod store;

pub use git_backend::{GitBackend, GitError, GitOperationContext, GitProgress, RepoPath};
pub use ide_launcher::{IdeLauncher, LaunchError};
pub use store::{SettingsStore, StoreError, WorkspaceStore};
