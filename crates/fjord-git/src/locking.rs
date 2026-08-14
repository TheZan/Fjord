use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use fjord_ports::RepoPath;

fn repo_lock(repo: &RepoPath) -> Arc<tokio::sync::RwLock<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::RwLock<()>>>>> = OnceLock::new();

    let key = std::fs::canonicalize(&repo.0).unwrap_or_else(|_| repo.0.clone());
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("repo lock registry should not be poisoned");
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::RwLock::new(())))
        .clone()
}

pub(crate) async fn read(repo: &RepoPath) -> tokio::sync::OwnedRwLockReadGuard<()> {
    repo_lock(repo).read_owned().await
}

pub(crate) async fn write(repo: &RepoPath) -> tokio::sync::OwnedRwLockWriteGuard<()> {
    repo_lock(repo).write_owned().await
}
