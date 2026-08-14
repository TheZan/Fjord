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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepositoryWatchScope {
    WorkingTree,
    GitMetadata,
}

/// Observable repository data affected by a filesystem event burst. Keeping
/// this classification beside the platform watcher lets the UI refresh only
/// the Git queries that can actually have changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RepoChangeSet {
    pub status: bool,
    pub working: bool,
    pub history: bool,
    pub refs: bool,
    pub stashes: bool,
    pub config: bool,
}

impl RepoChangeSet {
    fn all() -> Self {
        Self {
            status: true,
            working: true,
            history: true,
            refs: true,
            stashes: true,
            config: true,
        }
    }

    fn merge(&mut self, other: Self) {
        self.status |= other.status;
        self.working |= other.working;
        self.history |= other.history;
        self.refs |= other.refs;
        self.stashes |= other.stashes;
        self.config |= other.config;
    }

    fn is_empty(self) -> bool {
        !self.status
            && !self.working
            && !self.history
            && !self.refs
            && !self.stashes
            && !self.config
    }
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
    pub fn watch_repository<F>(repo_root: &Path, on_change: F) -> Result<Self, WatchError>
    where
        F: FnMut(RepoChangeSet) + Send + 'static,
    {
        Self::watch_repository_with_scope(repo_root, RepositoryWatchScope::WorkingTree, on_change)
    }

    /// Installs either the full working-tree watch used by hot/warm
    /// repositories or the metadata-only watch used by cold repositories.
    pub fn watch_repository_with_scope<F>(
        repo_root: &Path,
        scope: RepositoryWatchScope,
        mut on_change: F,
    ) -> Result<Self, WatchError>
    where
        F: FnMut(RepoChangeSet) + Send + 'static,
    {
        let root: PathBuf = repo_root.to_path_buf();
        let watched_root = match scope {
            RepositoryWatchScope::WorkingTree => root.clone(),
            RepositoryWatchScope::GitMetadata => git_metadata_path(&root)?,
        };
        let event_root = watched_root.clone();
        let (tx, rx) = mpsc::channel::<RepoChangeSet>();

        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else { return };
            let mut changes = if event.paths.is_empty() {
                // Empty-path events are rare platform catch-alls.
                RepoChangeSet::all()
            } else {
                RepoChangeSet::default()
            };
            for path in &event.paths {
                let classified_path = match scope {
                    RepositoryWatchScope::WorkingTree => path.clone(),
                    RepositoryWatchScope::GitMetadata => {
                        let relative = path.strip_prefix(&event_root).unwrap_or(path);
                        root.join(".git").join(relative)
                    }
                };
                changes.merge(classify_change(&root, &classified_path));
            }
            if !changes.is_empty() {
                let _ = tx.send(changes);
            }
        })
        .map_err(|e| WatchError::Start(e.to_string()))?;
        watcher
            .watch(&watched_root, RecursiveMode::Recursive)
            .map_err(|e| WatchError::Start(e.to_string()))?;

        std::thread::spawn(move || {
            while let Ok(mut changes) = rx.recv() {
                let deadline = Instant::now() + DEBOUNCE_MAX_DELAY;
                while Instant::now() < deadline {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(DEBOUNCE_QUIET.min(remaining)) {
                        Ok(next) => changes.merge(next),
                        Err(_) => break,
                    }
                }
                on_change(changes);
            }
        });

        Ok(Self { _watcher: watcher })
    }
}

fn git_metadata_path(repo_root: &Path) -> Result<PathBuf, WatchError> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git.canonicalize().unwrap_or(dot_git));
    }
    if dot_git.is_file() {
        let marker = std::fs::read_to_string(&dot_git)
            .map_err(|error| WatchError::Start(error.to_string()))?;
        let relative = marker
            .trim()
            .strip_prefix("gitdir:")
            .map(str::trim)
            .ok_or_else(|| WatchError::Start("invalid .git file".to_string()))?;
        let path = PathBuf::from(relative);
        let resolved = if path.is_absolute() {
            path
        } else {
            repo_root.join(path)
        };
        return Ok(resolved.canonicalize().unwrap_or(resolved));
    }
    if repo_root.join("HEAD").is_file() {
        return Ok(repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.to_path_buf()));
    }
    Err(WatchError::Start(format!(
        "{} has no Git metadata directory",
        repo_root.display()
    )))
}

/// Maps a path to the smallest observable data set it can affect. Generated
/// directories and noisy Git internals return an empty change set.
fn classify_change(root: &Path, path: &Path) -> RepoChangeSet {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();

    match components.first().map(|value| value.as_ref()) {
        Some(".git") => match components.get(1).map(|value| value.as_ref()) {
            Some("objects" | "logs") => RepoChangeSet::default(),
            Some("index") => RepoChangeSet {
                status: true,
                working: true,
                ..RepoChangeSet::default()
            },
            Some("refs") if components.get(2).is_some_and(|value| value == "stash") => {
                RepoChangeSet {
                    status: true,
                    working: true,
                    stashes: true,
                    ..RepoChangeSet::default()
                }
            }
            // FETCH_HEAD is rewritten even when a fetch receives no new
            // refs. Ignore it so periodic fetches do not redraw the graph.
            Some("FETCH_HEAD") => RepoChangeSet::default(),
            Some("config") => RepoChangeSet {
                status: true,
                refs: true,
                config: true,
                ..RepoChangeSet::default()
            },
            Some("refs" | "packed-refs") => RepoChangeSet {
                status: true,
                history: true,
                refs: true,
                ..RepoChangeSet::default()
            },
            Some("HEAD") => RepoChangeSet {
                status: true,
                working: true,
                history: true,
                refs: true,
                ..RepoChangeSet::default()
            },
            Some(_) | None => RepoChangeSet::all(),
        },
        Some(first) if IGNORED_DIRS.contains(&first) => RepoChangeSet::default(),
        _ if components
            .iter()
            .any(|name| IGNORED_DIRS.contains(&name.as_ref())) =>
        {
            RepoChangeSet::default()
        }
        _ => RepoChangeSet {
            status: true,
            working: true,
            ..RepoChangeSet::default()
        },
    }
}

#[cfg(test)]
fn is_relevant(root: &Path, path: &Path) -> bool {
    !classify_change(root, path).is_empty()
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
    fn classifies_worktree_and_git_metadata_changes() {
        let root = Path::new("/repo");

        assert_eq!(
            classify_change(root, Path::new("/repo/src/main.rs")),
            RepoChangeSet {
                status: true,
                working: true,
                ..RepoChangeSet::default()
            }
        );
        assert_eq!(
            classify_change(root, Path::new("/repo/.git/refs/remotes/origin/new-branch")),
            RepoChangeSet {
                status: true,
                history: true,
                refs: true,
                ..RepoChangeSet::default()
            }
        );
        assert_eq!(
            classify_change(root, Path::new("/repo/.git/refs/stash")),
            RepoChangeSet {
                status: true,
                working: true,
                stashes: true,
                ..RepoChangeSet::default()
            }
        );
        assert_eq!(
            classify_change(root, Path::new("/repo/.git/FETCH_HEAD")),
            RepoChangeSet::default()
        );
        assert_eq!(
            classify_change(root, Path::new("/repo/.git/config")),
            RepoChangeSet {
                status: true,
                refs: true,
                config: true,
                ..RepoChangeSet::default()
            }
        );
    }

    #[test]
    fn git_metadata_path_supports_directories_and_worktree_indirection() {
        let root = TempDir::new().unwrap();
        let repository = root.path().join("repository");
        let metadata = repository.join(".git");
        fs::create_dir_all(&metadata).unwrap();
        assert_eq!(
            git_metadata_path(&repository).unwrap(),
            metadata.canonicalize().unwrap()
        );

        let worktree = root.path().join("worktree");
        let shared = root.path().join("shared.git");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&shared).unwrap();
        fs::write(worktree.join(".git"), "gitdir: ../shared.git\n").unwrap();
        assert_eq!(
            git_metadata_path(&worktree).unwrap(),
            shared.canonicalize().unwrap()
        );
    }

    #[test]
    fn metadata_only_watch_ignores_worktree_edits() {
        let dir = TempDir::new().unwrap();
        let metadata = dir.path().join(".git");
        fs::create_dir_all(&metadata).unwrap();
        fs::write(metadata.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = RepoEventWatcher::watch_repository_with_scope(
            dir.path(),
            RepositoryWatchScope::GitMetadata,
            move |changes| {
                let _ = tx.send(changes);
            },
        )
        .unwrap();

        fs::write(dir.path().join("working.txt"), b"change").unwrap();
        assert!(rx.recv_timeout(DEBOUNCE_QUIET * 2).is_err());

        fs::write(metadata.join("HEAD"), b"ref: refs/heads/next\n").unwrap();
        let changes = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("metadata edit should reach a cold watcher");
        assert!(changes.refs && changes.history);
    }

    #[test]
    fn nested_edits_trigger_a_single_debounced_callback() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("src").join("deeply").join("nested");
        fs::create_dir_all(&nested).unwrap();

        let (tx, rx) = mpsc::channel();
        let _watcher = RepoEventWatcher::watch_repository(dir.path(), move |changes| {
            let _ = tx.send(changes);
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
        let _watcher = RepoEventWatcher::watch_repository(dir.path(), move |changes| {
            let _ = tx.send(changes);
        })
        .unwrap();

        fs::write(generated.join("index.js"), b"module.exports = 1;").unwrap();

        assert!(
            rx.recv_timeout(DEBOUNCE_QUIET * 4).is_err(),
            "generated-directory churn should be filtered out"
        );
    }
}
