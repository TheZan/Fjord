use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use fjord_db::{SqliteSettingsStore, SqliteWorkspaceStore};
use fjord_domain::{RepositoryEntry, RepositoryId};
use fjord_fs::RepoEventWatcher;
use fjord_git::GixGitBackend;
use fjord_services::{RepoService, SettingsService, WorkspaceService};

use crate::ide_launcher::SystemIdeLauncher;

/// Everything a command handler needs, built once in `bootstrap` and
/// `app.manage()`d (SDD §5.1: commands stay thin adapters over services).
pub struct AppState {
    pub settings: Arc<SettingsService>,
    pub workspaces: Arc<WorkspaceService>,
    pub repos: Arc<RepoService>,
    status_watchers: Arc<Mutex<HashMap<RepositoryId, RepoEventWatcher>>>,
}

pub async fn bootstrap(app_data_dir: &Path) -> Result<AppState, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("fjord.db");

    let pool = fjord_db::connect(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let workspace_store = Arc::new(SqliteWorkspaceStore::new(pool));
    let git_backend = Arc::new(GixGitBackend::new());
    let ide_launcher = Arc::new(SystemIdeLauncher);
    let workspace_service = Arc::new(WorkspaceService::new(
        workspace_store.clone(),
        git_backend.clone(),
    ));
    let existing_repos = workspace_service
        .list_all_repositories()
        .await
        .map_err(|e| e.to_string())?;

    let state = AppState {
        settings: Arc::new(SettingsService::new(settings_store.clone())),
        workspaces: workspace_service,
        repos: Arc::new(RepoService::new(
            workspace_store,
            settings_store,
            git_backend,
            ide_launcher,
        )),
        status_watchers: Arc::new(Mutex::new(HashMap::new())),
    };

    for repo in existing_repos {
        state.watch_repository_status(repo);
    }

    Ok(state)
}

impl AppState {
    pub fn watch_repository_status(&self, repo: RepositoryEntry) {
        let repo_id = repo.id;
        let mut watchers = self.status_watchers.lock().unwrap();
        if watchers.contains_key(&repo_id) {
            return;
        }

        let workspaces = self.workspaces.clone();
        // Avoid recursive working-tree watches here: large repos can contain
        // build outputs such as `target/` or `node_modules/`, and Windows can
        // exhaust memory while the app is still booting. The cache also
        // refreshes on dashboard reads, so this watcher is an incremental hint.
        let watcher = RepoEventWatcher::watch_git_metadata(&repo.path, move |event| {
            if event.is_err() {
                return;
            }

            let workspaces = workspaces.clone();
            tauri::async_runtime::spawn(async move {
                workspaces.schedule_repo_status_refresh(repo_id, true);
            });
        });

        match watcher {
            Ok(watcher) => {
                watchers.insert(repo_id, watcher);
            }
            Err(error) => {
                tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to watch repository status");
            }
        }
    }

    pub fn unwatch_repository_status(&self, repo_id: RepositoryId) {
        self.status_watchers.lock().unwrap().remove(&repo_id);
    }
}
