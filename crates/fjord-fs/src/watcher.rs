use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// App-facing watcher covering the whole working tree (docs/tasks.md
/// P4-15): recursive, but events under generated directories (build
/// outputs, dependency caches) and the `.git` object store are filtered
/// out, and bursts are debounced into a single callback — a rebase or an
/// `npm install` produces one invalidation, not a storm. Callers use it as
/// an invalidation hint and still perform cache refreshes on demand.
pub struct RepoEventWatcher {
    _watcher: RecommendedWatcher,
}

/// Directory names whose subtrees never affect `git status` enough to be
/// worth an invalidation storm (they churn constantly during builds and
/// are near-universally gitignored). A false negative here only delays the
/// cache until the next on-demand refresh.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".gradle",
    ".idea",
    ".vs",
];

/// Trailing-edge debounce: after the first event, keep absorbing until the
/// tree stays quiet for this long…
const DEBOUNCE_QUIET: Duration = Duration::from_millis(300);
/// …but never delay the callback beyond this, even under a constant stream
/// of events (e.g. a long checkout on a huge repo).
const DEBOUNCE_MAX_DELAY: Duration = Duration::from_secs(5);

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
    /// Watches `repo_root` recursively and calls `on_change` (debounced,
    /// filtered) whenever the repository plausibly changed state. The
    /// debounce thread exits when the watcher is dropped.
    pub fn watch_repository<F>(repo_root: &Path, mut on_change: F) -> Result<Self, WatchError>
    where
        F: FnMut() + Send + 'static,
    {
        let root: PathBuf = repo_root.to_path_buf();
        let (tx, rx) = mpsc::channel::<()>();

        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else { return };
            // Events with no paths are rare catch-alls — treat as relevant.
            if event.paths.is_empty() || event.paths.iter().any(|path| is_relevant(&root, path)) {
                let _ = tx.send(());
            }
        })
        .map_err(|e| WatchError::Start(e.to_string()))?;
        watcher
            .watch(repo_root, RecursiveMode::Recursive)
            .map_err(|e| WatchError::Start(e.to_string()))?;

        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                let deadline = Instant::now() + DEBOUNCE_MAX_DELAY;
                while Instant::now() < deadline && rx.recv_timeout(DEBOUNCE_QUIET).is_ok() {}
                on_change();
            }
        });

        Ok(Self { _watcher: watcher })
    }
}

/// `false` for paths inside ignored generated directories and for `.git`
/// internals that churn without changing observable status (the object
/// store); `true` for everything else, including `.git/index`, `HEAD`, and
/// refs — those are exactly what checkout/commit/fetch touch.
fn is_relevant(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let mut components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy());

    match components.next() {
        Some(first) if first == ".git" => {
            !matches!(components.next().as_deref(), Some("objects") | Some("logs"))
        }
        Some(first) if IGNORED_DIRS.contains(&first.as_ref()) => false,
        _ => !relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .any(|name| IGNORED_DIRS.contains(&name.as_ref())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn reports_a_file_creation() {
        let dir = TempDir::new().unwrap();
        let watcher = RepoWatcher::watch(dir.path()).unwrap();

        fs::write(dir.path().join("touched.txt"), b"hi").unwrap();

        let event = watcher.events.recv_timeout(Duration::from_secs(5));
        assert!(event.is_ok(), "expected a filesystem event within 5s");
    }

    #[test]
    fn relevance_filter_matches_the_contract() {
        let root = Path::new("/repo");
        // Working-tree files, however deep, are relevant.
        assert!(is_relevant(root, Path::new("/repo/src/deep/nested/mod.rs")));
        // Git metadata that mutations touch is relevant…
        assert!(is_relevant(root, Path::new("/repo/.git/index")));
        assert!(is_relevant(root, Path::new("/repo/.git/refs/heads/main")));
        // …but object-store and reflog churn is not.
        assert!(!is_relevant(root, Path::new("/repo/.git/objects/ab/cdef")));
        assert!(!is_relevant(root, Path::new("/repo/.git/logs/HEAD")));
        // Generated directories are ignored at any depth.
        assert!(!is_relevant(
            root,
            Path::new("/repo/node_modules/pkg/index.js")
        ));
        assert!(!is_relevant(
            root,
            Path::new("/repo/crates/app/target/debug/foo")
        ));
    }

    #[test]
    fn nested_edits_trigger_a_single_debounced_callback() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("src").join("deeply").join("nested");
        fs::create_dir_all(&nested).unwrap();

        let (tx, rx) = mpsc::channel();
        let _watcher = RepoEventWatcher::watch_repository(dir.path(), move || {
            let _ = tx.send(());
        })
        .unwrap();

        // A burst of edits below the repo root — the exact failure mode of
        // the old non-recursive watcher.
        for index in 0..5 {
            fs::write(nested.join(format!("file-{index}.txt")), b"change").unwrap();
        }

        assert!(
            rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "expected a debounced callback for nested edits"
        );
        // The whole burst must collapse into that one callback: after the
        // quiet window passes, no further callbacks arrive.
        assert!(
            rx.recv_timeout(DEBOUNCE_QUIET * 4).is_err(),
            "burst should be debounced into a single callback"
        );
    }

    #[test]
    fn ignored_directories_do_not_trigger_callbacks() {
        let dir = TempDir::new().unwrap();
        let generated = dir.path().join("node_modules").join("some-pkg");
        fs::create_dir_all(&generated).unwrap();

        let (tx, rx) = mpsc::channel();
        let _watcher = RepoEventWatcher::watch_repository(dir.path(), move || {
            let _ = tx.send(());
        })
        .unwrap();

        fs::write(generated.join("index.js"), b"module.exports = 1;").unwrap();

        assert!(
            rx.recv_timeout(DEBOUNCE_QUIET * 4).is_err(),
            "generated-directory churn should be filtered out"
        );
    }
}
