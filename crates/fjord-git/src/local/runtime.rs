//! Long-lived repository handles keyed by canonical working-tree path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use fjord_fs::RepoChangeSet;
use fjord_ports::{GitError, RepoPath};

use crate::generation::{
    mutation_mask, GenerationClock, GenerationMask, GenerationSet, MutationKind,
};

const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(5);

pub(super) struct RepositoryRuntime {
    gix: gix::ThreadSafeRepository,
    git2: Mutex<git2::Repository>,
    generations: GenerationClock,
}

impl RepositoryRuntime {
    fn open(path: &Path) -> Result<Self, GitError> {
        let gix = gix::ThreadSafeRepository::open(path).map_err(|error| match error {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotAGitRepository(path.to_path_buf())
            }
            other => GitError::Gix(other.to_string()),
        })?;
        let git2 = git2::Repository::open(path).map_err(super::LocalGitBackend::map_git2_error)?;
        Ok(Self {
            gix,
            git2: Mutex::new(git2),
            generations: GenerationClock::default(),
        })
    }

    pub(super) fn gix(&self) -> gix::Repository {
        self.gix.to_thread_local()
    }

    pub(super) fn with_git2<T>(
        &self,
        run: impl FnOnce(&mut git2::Repository) -> Result<T, GitError>,
    ) -> Result<T, GitError> {
        let mut repository = self
            .git2
            .lock()
            .map_err(|_| GitError::Git2("repository handle lock was poisoned".to_string()))?;
        run(&mut repository)
    }

    pub(super) fn generations(&self) -> GenerationSet {
        self.generations.snapshot()
    }

    fn bump(&self, mask: GenerationMask) {
        self.generations.bump(mask);
    }
}

enum Entry {
    Ready(Arc<RepositoryRuntime>),
    FailedUntil(Instant),
}

struct RegistryState {
    entries: HashMap<PathBuf, Entry>,
    open_attempts: HashMap<PathBuf, usize>,
}

pub(super) struct RepositoryRuntimeRegistry {
    negative_ttl: Duration,
    state: Mutex<RegistryState>,
}

impl RepositoryRuntimeRegistry {
    fn new(negative_ttl: Duration) -> Self {
        Self {
            negative_ttl,
            state: Mutex::new(RegistryState {
                entries: HashMap::new(),
                open_attempts: HashMap::new(),
            }),
        }
    }

    pub(super) fn resolve(&self, repo: &RepoPath) -> Result<Arc<RepositoryRuntime>, GitError> {
        let key = canonical_key(&repo.0);
        let mut state = self
            .state
            .lock()
            .map_err(|_| GitError::Gix("repository runtime registry was poisoned".to_string()))?;

        match state.entries.get(&key) {
            Some(Entry::Ready(runtime)) => return Ok(runtime.clone()),
            Some(Entry::FailedUntil(until)) if *until > Instant::now() => {
                return Err(GitError::NotAGitRepository(repo.0.clone()));
            }
            _ => {}
        }
        state.entries.remove(&key);
        *state.open_attempts.entry(key.clone()).or_default() += 1;

        match RepositoryRuntime::open(&repo.0) {
            Ok(runtime) => {
                let runtime = Arc::new(runtime);
                state.entries.insert(key, Entry::Ready(runtime.clone()));
                Ok(runtime)
            }
            Err(error) => {
                state
                    .entries
                    .insert(key, Entry::FailedUntil(Instant::now() + self.negative_ttl));
                Err(error)
            }
        }
    }

    fn ready(&self, repo: &RepoPath) -> Option<Arc<RepositoryRuntime>> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.entries.get(&canonical_key(&repo.0)) {
            Some(Entry::Ready(runtime)) => Some(runtime.clone()),
            Some(Entry::FailedUntil(_)) | None => None,
        }
    }

    #[cfg(test)]
    fn attempts(&self, repo: &RepoPath) -> usize {
        self.state
            .lock()
            .unwrap()
            .open_attempts
            .get(&canonical_key(&repo.0))
            .copied()
            .unwrap_or_default()
    }
}

fn canonical_key(path: &Path) -> PathBuf {
    fjord_fs::canonicalize_path(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|current| current.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

pub(super) fn registry() -> &'static RepositoryRuntimeRegistry {
    static REGISTRY: OnceLock<RepositoryRuntimeRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| RepositoryRuntimeRegistry::new(NEGATIVE_CACHE_TTL))
}

pub(super) fn bump_mutation(repo: &RepoPath, mutation: MutationKind) {
    if let Ok(runtime) = registry().resolve(repo) {
        runtime.bump(mutation_mask(mutation));
    }
}

pub(crate) fn record_watcher_changes(repo: &RepoPath, changes: RepoChangeSet) {
    let Some(runtime) = registry().ready(repo) else {
        return;
    };
    runtime.bump(watcher_mask(changes));
}

pub(crate) fn generations(repo: &RepoPath) -> Result<GenerationSet, GitError> {
    Ok(registry().resolve(repo)?.generations())
}

fn watcher_mask(changes: RepoChangeSet) -> GenerationMask {
    let mut mask = GenerationMask::NONE;
    // `status` is an app query-invalidation hint that accompanies refs and
    // config changes too. Treat it as working-tree state only when it is the
    // sole classification; explicit `working` is authoritative.
    if changes.working
        || (changes.status
            && !changes.refs
            && !changes.history
            && !changes.stashes
            && !changes.config)
    {
        mask.merge(GenerationMask::WORKING_TREE);
    }
    if changes.refs {
        mask.merge(GenerationMask::REFS);
    }
    if changes.history {
        mask.merge(GenerationMask::new(false, false, true, false, false));
    }
    if changes.stashes {
        mask.merge(GenerationMask::new(false, false, false, true, false));
    }
    if changes.config {
        mask.merge(GenerationMask::CONFIG);
    }
    mask
}

#[cfg(test)]
pub(super) fn open_attempts(repo: &RepoPath) -> usize {
    registry().attempts(repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_opens_are_single_flight_within_the_negative_window() {
        let directory = tempfile::TempDir::new().unwrap();
        let missing = RepoPath::new(directory.path().join("missing"));
        let registry = RepositoryRuntimeRegistry::new(Duration::from_millis(30));

        assert!(registry.resolve(&missing).is_err());
        assert!(registry.resolve(&missing).is_err());
        assert_eq!(registry.attempts(&missing), 1);

        std::thread::sleep(Duration::from_millis(35));
        assert!(registry.resolve(&missing).is_err());
        assert_eq!(registry.attempts(&missing), 2);
    }

    #[test]
    fn canonical_path_aliases_resolve_to_one_runtime() {
        let directory = tempfile::TempDir::new().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        let direct = RepoPath::new(directory.path().to_path_buf());
        let alias = RepoPath::new(directory.path().join("."));
        let registry = RepositoryRuntimeRegistry::new(NEGATIVE_CACHE_TTL);

        let first = registry.resolve(&direct).unwrap();
        let second = registry.resolve(&alias).unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(registry.attempts(&direct), 1);
    }

    #[test]
    fn watcher_changes_bump_only_the_classified_domains() {
        let cases = [
            (
                RepoChangeSet {
                    status: true,
                    ..RepoChangeSet::default()
                },
                GenerationMask::WORKING_TREE,
            ),
            (
                RepoChangeSet {
                    refs: true,
                    history: true,
                    ..RepoChangeSet::default()
                },
                GenerationMask::REFS_HISTORY,
            ),
            (
                RepoChangeSet {
                    stashes: true,
                    ..RepoChangeSet::default()
                },
                GenerationMask::new(false, false, false, true, false),
            ),
            (
                RepoChangeSet {
                    config: true,
                    ..RepoChangeSet::default()
                },
                GenerationMask::CONFIG,
            ),
        ];

        for (changes, expected) in cases {
            assert_eq!(watcher_mask(changes), expected);
        }
    }

    #[test]
    fn watcher_event_updates_an_existing_runtime_generation_set() {
        let directory = tempfile::TempDir::new().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        let repo = RepoPath::new(directory.path().to_path_buf());
        let runtime = registry().resolve(&repo).unwrap();

        record_watcher_changes(
            &repo,
            RepoChangeSet {
                status: true,
                working: true,
                ..RepoChangeSet::default()
            },
        );

        assert_eq!(
            runtime.generations(),
            GenerationSet {
                working_tree: 1,
                ..GenerationSet::default()
            }
        );
    }
}
