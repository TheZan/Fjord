use std::path::Path;
use std::sync::Arc;

use fjord_db::{SqliteSettingsStore, SqliteWorkspaceStore};
use fjord_git::GixGitBackend;
use fjord_services::{RepoService, SettingsService, WorkspaceService};

/// Everything a command handler needs, built once in `bootstrap` and
/// `app.manage()`d (SDD §5.1: commands stay thin adapters over services).
pub struct AppState {
    pub settings: Arc<SettingsService>,
    pub workspaces: Arc<WorkspaceService>,
    pub repos: Arc<RepoService>,
}

pub async fn bootstrap(app_data_dir: &Path) -> Result<AppState, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("fjord.db");

    let pool = fjord_db::connect(&db_path).await.map_err(|e| e.to_string())?;

    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let workspace_store = Arc::new(SqliteWorkspaceStore::new(pool));
    let git_backend = Arc::new(GixGitBackend::new());

    Ok(AppState {
        settings: Arc::new(SettingsService::new(settings_store)),
        workspaces: Arc::new(WorkspaceService::new(workspace_store.clone(), git_backend.clone())),
        repos: Arc::new(RepoService::new(workspace_store, git_backend)),
    })
}
