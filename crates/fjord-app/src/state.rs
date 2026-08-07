use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use fjord_db::{SqliteSettingsStore, SqliteWorkspaceStore};
use fjord_domain::{RepoStatusSummary, RepositoryEntry, RepositoryId};
use fjord_fs::{RepoChangeSet, RepoEventWatcher};
use fjord_git::{GixGitBackend, SystemGitEnvironmentProvider, SystemGitRemoteBackend};
use fjord_services::{RepoService, SettingsService, WorkspaceService};
use serde::Serialize;
use tauri::Emitter;

use crate::askpass::{AskpassBroker, AUTH_PROMPT_EVENT};
use crate::ide_launcher::SystemIdeLauncher;
use crate::operations::OperationRegistry;

pub const REPOSITORY_CHANGED_EVENT: &str = "fjord-repository-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryChangedEvent {
    repo_id: RepositoryId,
    status: bool,
    working: bool,
    history: bool,
    refs: bool,
    stashes: bool,
    status_summary: Option<RepoStatusSummary>,
}

impl RepositoryChangedEvent {
    fn new(
        repo_id: RepositoryId,
        changes: RepoChangeSet,
        status_summary: Option<RepoStatusSummary>,
    ) -> Self {
        Self {
            repo_id,
            status: changes.status,
            working: changes.working,
            history: changes.history,
            refs: changes.refs,
            stashes: changes.stashes,
            status_summary,
        }
    }
}

/// Everything a command handler needs, built once in `bootstrap` and
/// `app.manage()`d (SDD §5.1: commands stay thin adapters over services).
pub struct AppState {
    pub settings: Arc<SettingsService>,
    pub workspaces: Arc<WorkspaceService>,
    pub repos: Arc<RepoService>,
    pub operations: Arc<OperationRegistry>,
    pub askpass: Arc<AskpassBroker>,
    app_handle: tauri::AppHandle,
    status_watchers: Arc<Mutex<HashMap<RepositoryId, RepoEventWatcher>>>,
}

pub async fn bootstrap(
    app_data_dir: &Path,
    app_handle: tauri::AppHandle,
) -> Result<AppState, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("fjord.db");

    let pool = fjord_db::connect(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let workspace_store = Arc::new(SqliteWorkspaceStore::new(pool));
    let git_backend = Arc::new(GixGitBackend::new());
    let remote_backend = Arc::new(SystemGitRemoteBackend::new());
    let git_environment = Arc::new(SystemGitEnvironmentProvider::new());
    let ide_launcher = Arc::new(SystemIdeLauncher);
    let workspace_service = Arc::new(WorkspaceService::new(
        workspace_store.clone(),
        git_backend.clone(),
    ));
    let existing_repos = workspace_service
        .list_all_repositories()
        .await
        .map_err(|e| e.to_string())?;

    let prompt_app = app_handle.clone();
    let askpass = AskpassBroker::start(move |prompt| {
        if let Err(error) = prompt_app.emit(AUTH_PROMPT_EVENT, prompt) {
            tracing::warn!(error = %error, "failed to emit Git authentication prompt");
        }
    })
    .await
    .map_err(|error| format!("could not start askpass broker: {error}"))?;

    let state = AppState {
        settings: Arc::new(SettingsService::new(settings_store.clone())),
        workspaces: workspace_service,
        repos: Arc::new(RepoService::new(
            workspace_store,
            settings_store,
            git_backend,
            remote_backend,
            git_environment,
            ide_launcher,
        )),
        operations: Arc::new(OperationRegistry::default()),
        askpass: Arc::new(askpass),
        app_handle,
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
        let app_handle = self.app_handle.clone();
        // Recursive working-tree watch with generated-directory filtering
        // and debouncing inside fjord-fs (docs/tasks.md P4-15) — edits below
        // the repo root invalidate the cache, while `target/`/`node_modules/`
        // churn and event storms are absorbed before they reach us.
        let watcher = RepoEventWatcher::watch_repository(&repo.path, move |changes| {
            let workspaces = workspaces.clone();
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let status_summary = match workspaces.refresh_repo_status(repo_id).await {
                    Ok(summary) => Some(summary),
                    Err(error) => {
                        tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to refresh repository status after filesystem change");
                        None
                    }
                };
                if let Err(error) = app_handle.emit(
                    REPOSITORY_CHANGED_EVENT,
                    RepositoryChangedEvent::new(repo_id, changes, status_summary),
                ) {
                    tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to emit repository change event");
                }
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
