use std::path::Path;
use std::sync::Arc;

use fjord_db::{SqliteSettingsStore, SqliteWorkspaceStore};
use fjord_services::SettingsService;

/// Everything a command handler needs, built once in `bootstrap` and
/// `app.manage()`d. Phase 0 only wires `SettingsService` — later phases add
/// `WorkspaceService`, a `GitBackend` handle, etc. following the same
/// pattern (SDD §5.1: commands stay thin adapters over services).
pub struct AppState {
    pub settings: Arc<SettingsService>,
    /// Not yet exposed through any command (that starts in Phase 2, P2-01)
    /// but constructed here so the wiring pattern is established now.
    #[allow(dead_code)]
    pub workspaces: Arc<SqliteWorkspaceStore>,
}

pub async fn bootstrap(app_data_dir: &Path) -> Result<AppState, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("fjord.db");

    let pool = fjord_db::connect(&db_path).await.map_err(|e| e.to_string())?;

    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let workspace_store = Arc::new(SqliteWorkspaceStore::new(pool));

    Ok(AppState {
        settings: Arc::new(SettingsService::new(settings_store)),
        workspaces: workspace_store,
    })
}
