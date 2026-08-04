use std::path::Path;
use std::sync::mpsc;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WatchError {
    #[error("failed to start watching: {0}")]
    Start(String),
}

/// Watches a single repository's working tree for changes, so the caller
/// can invalidate that repository's `repo_status_cache` row instead of
/// re-running `status` on a timer. See docs/SDD.md §5.3 ("incremental
/// status, not full rescans").
///
/// `notify` abstracts FSEvents (macOS) / ReadDirectoryChangesW (Windows) /
/// inotify (Linux) behind one API — no per-OS branching needed here (SDD
/// §5.4). Wiring this into the status-cache refresh loop is P2-02; this
/// crate only owns "can we watch a path and get told when it changes."
pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
    pub events: mpsc::Receiver<notify::Result<Event>>,
}

/// Lightweight app-facing watcher. It avoids recursively watching the whole
/// working tree because generated directories can be very large; callers use
/// it as an invalidation hint and still perform cache refreshes on demand.
pub struct RepoEventWatcher {
    _watcher: RecommendedWatcher,
}

impl RepoWatcher {
    pub fn watch(path: &Path) -> Result<Self, WatchError> {
        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(tx).map_err(|e| WatchError::Start(e.to_string()))?;
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| WatchError::Start(e.to_string()))?;

        Ok(Self {
            _watcher: watcher,
            events: rx,
        })
    }
}

impl RepoEventWatcher {
    pub fn watch_git_metadata<F>(path: &Path, on_event: F) -> Result<Self, WatchError>
    where
        F: FnMut(notify::Result<Event>) + Send + 'static,
    {
        let mut watcher =
            notify::recommended_watcher(on_event).map_err(|e| WatchError::Start(e.to_string()))?;
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|e| WatchError::Start(e.to_string()))?;

        let git_dir = path.join(".git");
        if git_dir.is_dir() {
            watcher
                .watch(&git_dir, RecursiveMode::Recursive)
                .map_err(|e| WatchError::Start(e.to_string()))?;
        }

        Ok(Self { _watcher: watcher })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    #[test]
    fn reports_a_file_creation() {
        let dir = tempfile_dir();
        let watcher = RepoWatcher::watch(&dir).unwrap();

        fs::write(dir.join("touched.txt"), b"hi").unwrap();

        let event = watcher.events.recv_timeout(Duration::from_secs(5));
        assert!(event.is_ok(), "expected a filesystem event within 5s");

        fs::remove_dir_all(&dir).ok();
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fjord-fs-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn uuid_like() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
