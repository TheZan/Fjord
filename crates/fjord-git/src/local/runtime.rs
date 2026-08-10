//! Long-lived repository handles keyed by canonical working-tree path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use fjord_ports::{GitError, RepoPath};

const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(5);

pub(super) struct RepositoryRuntime {
    gix: gix::ThreadSafeRepository,
    git2: Mutex<git2::Repository>,
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
}
