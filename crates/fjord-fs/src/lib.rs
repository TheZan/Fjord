//! Filesystem concerns kept in one place so platform differences (case
//! sensitivity, path separators, watcher backends) never leak into
//! `fjord-services`. See docs/SDD.md §5.4.

mod path_compare;
mod watcher;

pub use path_compare::paths_equal;
pub use watcher::{RepoEventWatcher, RepoWatcher, WatchError};
