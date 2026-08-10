#![cfg_attr(test, allow(linker_messages))]

//! Git infrastructure wiring. Local repository behavior lives in [`local`]
//! and every network operation lives in [`remote`].

mod executable;
mod generation;
mod local;
mod locking;
pub mod remote;

pub use executable::GitCommandFactory;
pub use generation::{GenerationClock, GenerationMask, GenerationSet};
pub use local::LocalGitBackend;
pub use remote::backend::SystemGitRemoteBackend;
pub use remote::environment::SystemGitEnvironmentProvider;

/// Records a debounced external filesystem change against an existing
/// repository runtime. A runtime is not opened solely because a watcher fired.
pub fn record_repository_changes(repo: &fjord_ports::RepoPath, changes: fjord_fs::RepoChangeSet) {
    local::record_repository_changes(repo, changes);
}

/// Returns the current in-memory generations, opening the runtime on first use.
pub fn repository_generations(
    repo: &fjord_ports::RepoPath,
) -> Result<GenerationSet, fjord_ports::GitError> {
    local::repository_generations(repo)
}

/// Retains handles only for the configured hot/warm repositories. Reads of a
/// cold repository remain valid but use an ephemeral handle.
pub fn set_resident_repositories(repositories: &[fjord_ports::RepoPath]) {
    local::set_resident_repositories(repositories);
}

/// Drops all runtime state for a repository that is no longer tracked.
pub fn forget_repository(repo: &fjord_ports::RepoPath) {
    local::forget_repository(repo);
}
