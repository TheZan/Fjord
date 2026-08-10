use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use fjord_db::{SqliteSettingsStore, SqliteUiStateStore, SqliteWorkspaceStore};
use fjord_domain::{GenerationSet, RepoStatusSummary, RepositoryEntry, RepositoryId};
use fjord_fs::{RepoChangeSet, RepoEventWatcher, RepositoryWatchScope};
use fjord_git::{
    GitCommandFactory, LocalGitBackend, SystemGitEnvironmentProvider, SystemGitRemoteBackend,
};
use fjord_ports::GitAskpassConfig;
use fjord_services::{
    RepoService, SettingsService, UiStateService, WorkspaceError, WorkspaceService,
};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{Emitter, Manager};

use crate::askpass::{AskpassBroker, AUTH_PROMPT_EVENT};
use crate::ide_launcher::SystemIdeLauncher;
use crate::interaction_traces::InteractionTraceCollector;
use crate::operations::OperationRegistry;
use crate::repository_tiers::{RepositoryTier, RepositoryTierPolicy};

pub const REPOSITORY_CHANGED_EVENT: &str = "fjord-repository-changed";

struct ManagedWatcher {
    scope: RepositoryWatchScope,
    repo_path: fjord_ports::RepoPath,
    _watcher: RepoEventWatcher,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryChangedEvent {
    repo_id: RepositoryId,
    status: bool,
    working: bool,
    history: bool,
    refs: bool,
    stashes: bool,
    config: bool,
    generations: GenerationSet,
    status_summary: Option<RepoStatusSummary>,
}

impl RepositoryChangedEvent {
    fn new(
        repo_id: RepositoryId,
        changes: RepoChangeSet,
        generations: GenerationSet,
        status_summary: Option<RepoStatusSummary>,
    ) -> Self {
        Self {
            repo_id,
            status: changes.status,
            working: changes.working,
            history: changes.history,
            refs: changes.refs,
            stashes: changes.stashes,
            config: changes.config,
            generations,
            status_summary,
        }
    }
}

/// Everything a command handler needs, built once in `bootstrap` and
/// `app.manage()`d (SDD §5.1: commands stay thin adapters over services).
pub struct AppState {
    pub settings: Arc<SettingsService>,
    pub ui_state: Arc<UiStateService>,
    pub workspaces: Arc<WorkspaceService>,
    pub repos: Arc<RepoService>,
    pub operations: Arc<OperationRegistry>,
    pub askpass: Arc<AskpassBroker>,
    pub interaction_traces: Arc<InteractionTraceCollector>,
    askpass_executable: Option<PathBuf>,
    app_handle: tauri::AppHandle,
    status_watchers: Arc<Mutex<HashMap<RepositoryId, ManagedWatcher>>>,
    snapshot_tasks: Arc<Mutex<HashMap<RepositoryId, JoinHandle<()>>>>,
    repository_tiers: Arc<Mutex<RepositoryTierPolicy>>,
    tier_demotion_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    startup_activated: tokio::sync::Mutex<bool>,
}

/// The services a command handler talks to, built on the real adapters.
///
/// Split out of [`bootstrap`] so the wiring can be exercised against a
/// temporary database and fixture repositories without a Tauri runtime
/// (docs/tasks.md P5-22). Everything below this line in `bootstrap` is
/// runtime-bound: the event sink, the askpass broker, and the watchers.
pub struct Services {
    pub settings: Arc<SettingsService>,
    pub ui_state: Arc<UiStateService>,
    pub workspaces: Arc<WorkspaceService>,
    pub repos: Arc<RepoService>,
}

pub async fn compose_services(app_data_dir: &Path) -> Result<Services, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("fjord.db");

    let pool = fjord_db::connect(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let ui_state_store = Arc::new(SqliteUiStateStore::new(pool.clone()));
    let workspace_store = Arc::new(SqliteWorkspaceStore::new(pool));
    // One executable for every Git subprocess: the local backend shares this
    // factory, and `refresh_git_executable` below points it at the same path
    // the remote transport resolves from settings.
    let git_backend = Arc::new(LocalGitBackend::with_commands(GitCommandFactory::new()));
    let remote_backend = Arc::new(SystemGitRemoteBackend::new());
    let git_environment = Arc::new(SystemGitEnvironmentProvider::new());
    let ide_launcher = Arc::new(SystemIdeLauncher);
    let workspace_service = Arc::new(WorkspaceService::new(
        workspace_store.clone(),
        git_backend.clone(),
    ));
    let repo_service = Arc::new(RepoService::new(
        workspace_store,
        settings_store.clone(),
        git_backend,
        remote_backend,
        git_environment,
        ide_launcher,
    ));

    Ok(Services {
        settings: Arc::new(SettingsService::new(settings_store)),
        ui_state: Arc::new(UiStateService::new(ui_state_store)),
        workspaces: workspace_service,
        repos: repo_service,
    })
}

pub async fn bootstrap(
    app_data_dir: &Path,
    app_handle: tauri::AppHandle,
) -> Result<AppState, String> {
    let services = compose_services(app_data_dir).await?;
    let performance_diagnostics = services
        .settings
        .get_settings()
        .await
        .map_err(|error| error.to_string())?
        .performance_diagnostics;
    let prompt_app = app_handle.clone();
    let askpass = AskpassBroker::start(move |prompt| {
        if let Err(error) = prompt_app.emit(AUTH_PROMPT_EVENT, prompt) {
            tracing::warn!(error = %error, "failed to emit Git authentication prompt");
        }
    })
    .await
    .map_err(|error| format!("could not start askpass broker: {error}"))?;
    let askpass_executable = resolve_askpass_executable(&app_handle);
    if askpass_executable.is_none() {
        tracing::warn!("fjord-askpass sidecar was not found; interactive fallback is unavailable");
    }

    let state = AppState {
        settings: services.settings,
        ui_state: services.ui_state,
        workspaces: services.workspaces,
        repos: services.repos,
        operations: Arc::new(OperationRegistry::default()),
        askpass: Arc::new(askpass),
        interaction_traces: Arc::new(InteractionTraceCollector::new(performance_diagnostics)),
        askpass_executable,
        app_handle,
        status_watchers: Arc::new(Mutex::new(HashMap::new())),
        snapshot_tasks: Arc::new(Mutex::new(HashMap::new())),
        repository_tiers: Arc::new(Mutex::new(RepositoryTierPolicy::default())),
        tier_demotion_task: Arc::new(Mutex::new(None)),
        startup_activated: tokio::sync::Mutex::new(false),
    };

    Ok(state)
}

impl AppState {
    /// Starts every startup operation that may touch Git or install a watcher.
    /// The frontend invokes this only after its first paint; the mutex makes
    /// React StrictMode retries and duplicate IPC calls harmless.
    pub async fn activate_after_first_paint(&self) -> Result<(), WorkspaceError> {
        let mut activated = self.startup_activated.lock().await;
        if *activated {
            return Ok(());
        }

        self.repos.refresh_git_executable().await;
        let repositories = self.workspaces.list_all_repositories().await?;
        self.sync_repository_tiers(&repositories);
        *activated = true;
        Ok(())
    }

    /// Whether Git can prompt through Fjord at all. `false` means the bundled
    /// sidecar is missing — a packaging problem that otherwise only shows up as
    /// an authentication failure on the first repository that needs a prompt.
    pub fn askpass_available(&self) -> bool {
        self.askpass_executable.is_some()
    }

    pub fn begin_askpass_operation(
        &self,
        operation_id: &str,
        repository_name: Option<String>,
        operation_kind: Option<String>,
    ) -> Option<GitAskpassConfig> {
        let executable = self.askpass_executable.clone()?;
        let session =
            self.askpass
                .begin_operation(operation_id.to_string(), repository_name, operation_kind);
        Some(GitAskpassConfig::new(
            executable,
            session.address().to_string(),
            session.token().to_string(),
            session.operation_id().to_string(),
        ))
    }

    pub async fn set_repository_activity(
        &self,
        workspace_id: Option<fjord_domain::WorkspaceId>,
        repository_id: Option<RepositoryId>,
    ) -> Result<(), WorkspaceError> {
        let repositories = self.workspaces.list_all_repositories().await?;
        let repository_id = repository_id.filter(|id| {
            repositories.iter().any(|repository| {
                repository.id == *id
                    && workspace_id.is_none_or(|workspace| repository.workspace_id == workspace)
            })
        });
        self.repository_tiers
            .lock()
            .unwrap()
            .activate(workspace_id, repository_id, Instant::now());
        self.sync_repository_tiers(&repositories);
        self.schedule_idle_demotion();
        Ok(())
    }

    pub async fn refresh_repository_tiers(&self) -> Result<(), WorkspaceError> {
        let repositories = self.workspaces.list_all_repositories().await?;
        self.sync_repository_tiers(&repositories);
        Ok(())
    }

    fn sync_repository_tiers(&self, repositories: &[RepositoryEntry]) {
        let tiers = self
            .repository_tiers
            .lock()
            .unwrap()
            .tiers(repositories, Instant::now());
        let resident = repositories
            .iter()
            .filter(|repository| tiers.get(&repository.id) != Some(&RepositoryTier::Cold))
            .map(|repository| fjord_ports::RepoPath::new(repository.path.clone()))
            .collect::<Vec<_>>();
        fjord_git::set_resident_repositories(&resident);

        let known = repositories
            .iter()
            .map(|repository| repository.id)
            .collect::<std::collections::HashSet<_>>();
        let removed = {
            let mut watchers = self.status_watchers.lock().unwrap();
            let removed = watchers
                .keys()
                .filter(|id| !known.contains(id))
                .copied()
                .collect::<Vec<_>>();
            removed
                .into_iter()
                .filter_map(|id| watchers.remove(&id).map(|watcher| (id, watcher)))
                .collect::<Vec<_>>()
        };
        for (id, watcher) in removed {
            self.repository_tiers.lock().unwrap().remove(id);
            if let Some(task) = self.snapshot_tasks.lock().unwrap().remove(&id) {
                task.abort();
            }
            if !repositories
                .iter()
                .any(|repository| fjord_fs::paths_equal(&repository.path, &watcher.repo_path.0))
            {
                fjord_git::forget_repository(&watcher.repo_path);
            }
        }

        for repository in repositories {
            let scope = match tiers
                .get(&repository.id)
                .copied()
                .unwrap_or(RepositoryTier::Cold)
            {
                RepositoryTier::Hot | RepositoryTier::Warm => RepositoryWatchScope::WorkingTree,
                RepositoryTier::Cold => RepositoryWatchScope::GitMetadata,
            };
            self.watch_repository_status(repository.clone(), scope);
        }
    }

    fn schedule_idle_demotion(&self) {
        let mut task = self.tier_demotion_task.lock().unwrap();
        if let Some(previous) = task.take() {
            previous.abort();
        }
        let delay = self.repository_tiers.lock().unwrap().hot_idle();
        let app_handle = self.app_handle.clone();
        *task = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let state = app_handle.state::<AppState>();
            if let Err(error) = state.refresh_repository_tiers().await {
                tracing::warn!(error = %error, "failed to apply idle repository demotion");
            }
        }));
    }

    fn watch_repository_status(&self, repo: RepositoryEntry, scope: RepositoryWatchScope) {
        let repo_id = repo.id;
        let mut watchers = self.status_watchers.lock().unwrap();
        if watchers
            .get(&repo_id)
            .is_some_and(|watcher| watcher.scope == scope)
        {
            return;
        }
        watchers.remove(&repo_id);

        let workspaces = self.workspaces.clone();
        let repos = self.repos.clone();
        let app_handle = self.app_handle.clone();
        let snapshot_tasks = self.snapshot_tasks.clone();
        let repo_path = fjord_ports::RepoPath::new(repo.path.clone());
        let callback_repo_path = repo_path.clone();
        let watcher = RepoEventWatcher::watch_repository_with_scope(
            &repo.path,
            scope,
            move |changes| {
                fjord_git::record_repository_changes(&callback_repo_path, changes);
                let repos_for_snapshot = repos.clone();
                let mut tasks = snapshot_tasks.lock().unwrap();
                if let Some(previous) = tasks.remove(&repo_id) {
                    previous.abort();
                }
                tasks.insert(
                repo_id,
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if let Err(error) = repos_for_snapshot
                        .capture_repository_snapshot(repo_id)
                        .await
                    {
                        tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to capture repository snapshot after generation quiescence");
                    }
                }),
            );
                drop(tasks);
                let workspaces = workspaces.clone();
                let app_handle = app_handle.clone();
                let repo_path = callback_repo_path.clone();
                tauri::async_runtime::spawn(async move {
                    let status_summary = match workspaces.refresh_repo_status(repo_id).await {
                        Ok(summary) => Some(summary),
                        Err(error) => {
                            tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to refresh repository status after filesystem change");
                            None
                        }
                    };
                    let generations =
                        fjord_git::repository_generations(&repo_path).unwrap_or_default();
                    if let Err(error) = app_handle.emit(
                        REPOSITORY_CHANGED_EVENT,
                        RepositoryChangedEvent::new(repo_id, changes, generations, status_summary),
                    ) {
                        tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to emit repository change event");
                    }
                });
            },
        );

        match watcher {
            Ok(watcher) => {
                watchers.insert(
                    repo_id,
                    ManagedWatcher {
                        scope,
                        repo_path,
                        _watcher: watcher,
                    },
                );
            }
            Err(error) => {
                tracing::warn!(repo_id = %repo_id.0, error = %error, "failed to watch repository status");
            }
        }
    }
}

fn resolve_askpass_executable(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    let file_name = if cfg!(windows) {
        "fjord-askpass.exe"
    } else {
        "fjord-askpass"
    };
    let mut candidates = Vec::new();
    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            candidates.push(directory.join(file_name));
            if directory.file_name().is_some_and(|name| name == "deps") {
                if let Some(parent) = directory.parent() {
                    candidates.push(parent.join(file_name));
                }
            }
        }
    }
    if let Ok(resource_directory) = app_handle.path().resource_dir() {
        candidates.push(resource_directory.join(file_name));
    }
    candidates.into_iter().find(|path| path.is_file())
}
