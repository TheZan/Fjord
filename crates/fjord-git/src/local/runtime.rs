//! Long-lived repository handles keyed by canonical working-tree path.

use std::collections::{HashMap, HashSet};
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
    generations: Arc<GenerationClock>,
}

impl RepositoryRuntime {
    fn open(path: &Path, generations: Arc<GenerationClock>) -> Result<Self, GitError> {
        let gix = gix::ThreadSafeRepository::open(path).map_err(|error| match error {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotAGitRepository(path.to_path_buf())
            }
            other => super::LocalGitBackend::map_gix_error(other),
        })?;
        let git2 = git2::Repository::open(path).map_err(super::LocalGitBackend::map_git2_error)?;
        Ok(Self {
            gix,
            git2: Mutex::new(git2),
            generations,
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

struct Entry {
    runtime: Option<Arc<RepositoryRuntime>>,
    failed_until: Option<Instant>,
    generations: Arc<GenerationClock>,
}

impl Entry {
    fn cold() -> Self {
        Self {
            runtime: None,
            failed_until: None,
            generations: Arc::new(GenerationClock::default()),
        }
    }
}

struct RegistryState {
    entries: HashMap<PathBuf, Entry>,
    open_attempts: HashMap<PathBuf, usize>,
    /// `None` keeps the pre-tiering behavior for isolated backend use. Once
    /// configured by the application, only these paths retain open handles;
    /// cold reads use an ephemeral runtime while preserving generations.
    resident: Option<HashSet<PathBuf>>,
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
                resident: None,
            }),
        }
    }

    pub(super) fn resolve(&self, repo: &RepoPath) -> Result<Arc<RepositoryRuntime>, GitError> {
        let key = canonical_key(&repo.0);
        let mut state = self
            .state
            .lock()
            .map_err(|_| GitError::Gix("repository runtime registry was poisoned".to_string()))?;

        if let Some(runtime) = state
            .entries
            .get(&key)
            .and_then(|entry| entry.runtime.as_ref())
        {
            return Ok(runtime.clone());
        }
        if state
            .entries
            .get(&key)
            .and_then(|entry| entry.failed_until)
            .is_some_and(|until| until > Instant::now())
        {
            return Err(GitError::NotAGitRepository(repo.0.clone()));
        }
        let generations = state
            .entries
            .entry(key.clone())
            .or_insert_with(Entry::cold)
            .generations
            .clone();
        *state.open_attempts.entry(key.clone()).or_default() += 1;

        match RepositoryRuntime::open(&repo.0, generations) {
            Ok(runtime) => {
                let runtime = Arc::new(runtime);
                let retain = state
                    .resident
                    .as_ref()
                    .is_none_or(|resident| resident.contains(&key));
                let entry = state.entries.get_mut(&key).expect("entry was inserted");
                entry.failed_until = None;
                if retain {
                    entry.runtime = Some(runtime.clone());
                }
                Ok(runtime)
            }
            Err(error) => {
                let entry = state.entries.get_mut(&key).expect("entry was inserted");
                entry.runtime = None;
                entry.failed_until = Some(Instant::now() + self.negative_ttl);
                Err(error)
            }
        }
    }

    fn bump_registered(&self, repo: &RepoPath, mask: GenerationMask) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .entries
            .entry(canonical_key(&repo.0))
            .or_insert_with(Entry::cold)
            .generations
            .bump(mask);
    }

    fn set_resident(&self, repositories: &[RepoPath]) {
        let resident = repositories
            .iter()
            .map(|repo| canonical_key(&repo.0))
            .collect::<HashSet<_>>();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (path, entry) in &mut state.entries {
            if !resident.contains(path) {
                entry.runtime = None;
            }
        }
        state.resident = Some(resident);
    }

    fn forget(&self, repo: &RepoPath) {
        let key = canonical_key(&repo.0);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.entries.remove(&key);
        state.open_attempts.remove(&key);
        if let Some(resident) = &mut state.resident {
            resident.remove(&key);
        }
    }

    #[cfg(test)]
    fn resident_count(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|entry| entry.runtime.is_some())
            .count()
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
    registry().bump_registered(repo, watcher_mask(changes));
}

pub(crate) fn generations(repo: &RepoPath) -> Result<GenerationSet, GitError> {
    Ok(registry().resolve(repo)?.generations())
}

pub(crate) fn set_resident(repositories: &[RepoPath]) {
    registry().set_resident(repositories);
}

pub(crate) fn forget(repo: &RepoPath) {
    registry().forget(repo);
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
    fn cold_eviction_drops_handles_but_preserves_generations() {
        let directory = tempfile::TempDir::new().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        let repo = RepoPath::new(directory.path().to_path_buf());
        let registry = RepositoryRuntimeRegistry::new(NEGATIVE_CACHE_TTL);
        registry.set_resident(std::slice::from_ref(&repo));
        let runtime = registry.resolve(&repo).unwrap();
        runtime.bump(GenerationMask::WORKING_TREE);
        assert_eq!(registry.resident_count(), 1);

        drop(runtime);
        registry.set_resident(&[]);
        assert_eq!(registry.resident_count(), 0);
        let reopened = registry.resolve(&repo).unwrap();
        assert_eq!(reopened.generations().working_tree, 1);
        assert_eq!(registry.resident_count(), 0, "cold reads are ephemeral");
    }

    #[cfg(windows)]
    #[test]
    fn evicted_working_tree_can_be_renamed_on_windows() {
        let root = tempfile::TempDir::new().unwrap();
        let repository_path = root.path().join("repository");
        git2::Repository::init(&repository_path).unwrap();
        let repo = RepoPath::new(repository_path.clone());
        let registry = RepositoryRuntimeRegistry::new(NEGATIVE_CACHE_TTL);
        registry.set_resident(std::slice::from_ref(&repo));
        let runtime = registry.resolve(&repo).unwrap();

        drop(runtime);
        registry.set_resident(&[]);
        std::fs::rename(&repository_path, root.path().join("renamed")).unwrap();
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
