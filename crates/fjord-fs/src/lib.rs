//! Filesystem concerns kept in one place so platform differences (case
//! sensitivity, path separators, watcher backends) never leak into
//! `fjord-services`. See docs/SDD.md §5.4.

mod discovery;
mod path_compare;
mod watcher;

pub use discovery::{discover_git_repositories, DiscoveryError};
pub use path_compare::{canonicalize_path, paths_equal};
pub use watcher::{RepoChangeSet, RepoEventWatcher, RepoWatcher, WatchError};
