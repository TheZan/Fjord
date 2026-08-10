use std::path::PathBuf;
use std::str::FromStr;

use async_trait::async_trait;
use fjord_domain::{
    RepoStatus, RepoStatusSummary, RepositoryEntry, RepositoryId, RepositorySnapshot,
    StoredRepositorySnapshot, Workspace, WorkspaceId,
};
use fjord_ports::{StoreError, WorkspaceStore};
use sqlx::{Row, SqlitePool};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

pub struct SqliteWorkspaceStore {
    pool: SqlitePool,
}

impl SqliteWorkspaceStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl WorkspaceStore for SqliteWorkspaceStore {
    async fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        // `created_at` as a tiebreaker makes ordering deterministic even when
        // two rows share a `sort_order` (e.g. both computed as MAX+1 in the
        // same instant) — otherwise which one a caller like
        // `ensureDefaultWorkspace` treats as "the" first workspace is
        // implementation-defined SQLite behavior, not a real guarantee.
        let rows = sqlx::query(
            "SELECT id, name, sort_order FROM workspaces ORDER BY sort_order, created_at",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|row| {
                let id = Uuid::from_str(&row.get::<String, _>("id"))
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                Ok(Workspace {
                    id: WorkspaceId(id),
                    name: row.get("name"),
                    sort_order: row.get("sort_order"),
                })
            })
            .collect()
    }

    async fn create_workspace(&self, name: &str) -> Result<Workspace, StoreError> {
        let id = WorkspaceId::new();
        let sort_order = self.next_workspace_sort_order().await?;

        sqlx::query(
            "INSERT INTO workspaces (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id.0.to_string())
        .bind(name)
        .bind(sort_order)
        .bind(OffsetDateTime::now_utc().to_string())
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(Workspace {
            id,
            name: name.to_string(),
            sort_order,
        })
    }

    async fn rename_workspace(&self, id: WorkspaceId, name: &str) -> Result<Workspace, StoreError> {
        let result = sqlx::query("UPDATE workspaces SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id.0.to_string())
            .execute(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(StoreError::WorkspaceNotFound(id));
        }

        let row = sqlx::query("SELECT sort_order FROM workspaces WHERE id = ?")
            .bind(id.0.to_string())
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(Workspace {
            id,
            name: name.to_string(),
            sort_order: row.get("sort_order"),
        })
    }

    async fn reorder_workspaces(&self, ids: &[WorkspaceId]) -> Result<(), StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

        for (index, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE workspaces SET sort_order = ? WHERE id = ?")
                .bind(index as i32)
                .bind(id.0.to_string())
                .execute(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
        }

        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))
    }

    async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id.0.to_string())
            .execute(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(())
    }

    async fn list_repositories(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepositoryEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, workspace_id, name, path, sort_order FROM repositories WHERE workspace_id = ? ORDER BY sort_order, created_at",
        )
        .bind(workspace_id.0.to_string())
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|row| {
                let id = Uuid::from_str(&row.get::<String, _>("id"))
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                Ok(RepositoryEntry {
                    id: RepositoryId(id),
                    workspace_id,
                    name: row.get("name"),
                    path: PathBuf::from(row.get::<String, _>("path")),
                    sort_order: row.get("sort_order"),
                })
            })
            .collect()
    }

    async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, workspace_id, name, path, sort_order FROM repositories ORDER BY workspace_id, sort_order, created_at",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|row| {
                let id = Uuid::from_str(&row.get::<String, _>("id"))
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                let workspace_id = Uuid::from_str(&row.get::<String, _>("workspace_id"))
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                Ok(RepositoryEntry {
                    id: RepositoryId(id),
                    workspace_id: WorkspaceId(workspace_id),
                    name: row.get("name"),
                    path: PathBuf::from(row.get::<String, _>("path")),
                    sort_order: row.get("sort_order"),
                })
            })
            .collect()
    }

    async fn get_repository(&self, id: RepositoryId) -> Result<RepositoryEntry, StoreError> {
        let row = sqlx::query(
            "SELECT id, workspace_id, name, path, sort_order FROM repositories WHERE id = ?",
        )
        .bind(id.0.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?
        .ok_or(StoreError::RepositoryNotFound(id))?;

        let workspace_id = Uuid::from_str(&row.get::<String, _>("workspace_id"))
            .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(RepositoryEntry {
            id,
            workspace_id: WorkspaceId(workspace_id),
            name: row.get("name"),
            path: PathBuf::from(row.get::<String, _>("path")),
            sort_order: row.get("sort_order"),
        })
    }

    async fn add_repository(
        &self,
        workspace_id: WorkspaceId,
        name: &str,
        path: &std::path::Path,
    ) -> Result<RepositoryEntry, StoreError> {
        let id = RepositoryId::new();
        let sort_order = self.next_repository_sort_order(workspace_id).await?;

        sqlx::query(
            "INSERT INTO repositories (id, workspace_id, name, path, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id.0.to_string())
        .bind(workspace_id.0.to_string())
        .bind(name)
        .bind(path.to_string_lossy().to_string())
        .bind(sort_order)
        .bind(OffsetDateTime::now_utc().to_string())
        .execute(&self.pool)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .is_some_and(|database| database.is_unique_violation())
            {
                StoreError::RepositoryAlreadyExists(path.to_path_buf())
            } else {
                StoreError::Database(error.to_string())
            }
        })?;

        Ok(RepositoryEntry {
            id,
            workspace_id,
            name: name.to_string(),
            path: path.to_path_buf(),
            sort_order,
        })
    }

    async fn remove_repository(&self, id: RepositoryId) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM repositories WHERE id = ?")
            .bind(id.0.to_string())
            .execute(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(())
    }

    async fn list_workspace_status(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepoStatusSummary>, StoreError> {
        let rows = sqlx::query(
            "SELECT r.id AS repo_id, c.branch, c.ahead, c.behind, c.dirty_count, c.has_conflict, c.last_synced_at \
             FROM repositories r \
             LEFT JOIN repo_status_cache c ON c.repo_id = r.id \
             WHERE r.workspace_id = ? \
             ORDER BY r.sort_order, r.created_at",
        )
        .bind(workspace_id.0.to_string())
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|row| {
                let repo_id = Uuid::from_str(&row.get::<String, _>("repo_id"))
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                let last_synced_at = row
                    .get::<Option<String>, _>("last_synced_at")
                    .map(|value| OffsetDateTime::parse(&value, &Rfc3339))
                    .transpose()
                    .map_err(|e| StoreError::Database(e.to_string()))?;

                Ok(RepoStatusSummary {
                    repo_id: RepositoryId(repo_id),
                    status: RepoStatus {
                        branch: row.get("branch"),
                        ahead: row.get::<Option<i64>, _>("ahead").unwrap_or_default() as u32,
                        behind: row.get::<Option<i64>, _>("behind").unwrap_or_default() as u32,
                        dirty_count: row.get::<Option<i64>, _>("dirty_count").unwrap_or_default()
                            as u32,
                        has_conflict: row
                            .get::<Option<i64>, _>("has_conflict")
                            .unwrap_or_default()
                            != 0,
                    },
                    last_synced_at,
                })
            })
            .collect()
    }

    async fn upsert_repo_status(
        &self,
        repo_id: RepositoryId,
        status: &RepoStatus,
    ) -> Result<RepoStatusSummary, StoreError> {
        let last_synced_at = OffsetDateTime::now_utc();

        sqlx::query(
            "INSERT INTO repo_status_cache (repo_id, branch, ahead, behind, dirty_count, has_conflict, last_synced_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(repo_id) DO UPDATE SET \
                branch = excluded.branch, \
                ahead = excluded.ahead, \
                behind = excluded.behind, \
                dirty_count = excluded.dirty_count, \
                has_conflict = excluded.has_conflict, \
                last_synced_at = excluded.last_synced_at",
        )
        .bind(repo_id.0.to_string())
        .bind(status.branch.as_deref())
        .bind(status.ahead as i64)
        .bind(status.behind as i64)
        .bind(status.dirty_count as i64)
        .bind(if status.has_conflict { 1_i64 } else { 0_i64 })
        .bind(last_synced_at.format(&Rfc3339).map_err(|e| StoreError::Database(e.to_string()))?)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(RepoStatusSummary {
            repo_id,
            status: status.clone(),
            last_synced_at: Some(last_synced_at),
        })
    }

    async fn invalidate_repo_status(&self, repo_id: RepositoryId) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM repo_status_cache WHERE repo_id = ?")
            .bind(repo_id.0.to_string())
            .execute(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(())
    }

    async fn load_repository_snapshot(
        &self,
        repo_id: RepositoryId,
        schema_version: u32,
    ) -> Result<Option<StoredRepositorySnapshot>, StoreError> {
        let Some(row) = sqlx::query(
            "SELECT schema_version, payload, captured_at FROM repo_snapshot WHERE repo_id = ?",
        )
        .bind(repo_id.0.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?
        else {
            return Ok(None);
        };

        if row.get::<i64, _>("schema_version") != i64::from(schema_version) {
            return Ok(None);
        }

        let snapshot = serde_json::from_str::<RepositorySnapshot>(row.get("payload"))
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let captured_at = OffsetDateTime::parse(row.get("captured_at"), &Rfc3339)
            .map_err(|error| StoreError::Database(error.to_string()))?;

        Ok(Some(StoredRepositorySnapshot {
            repo_id,
            snapshot,
            captured_at,
            validated: false,
        }))
    }

    async fn upsert_repository_snapshot(
        &self,
        repo_id: RepositoryId,
        schema_version: u32,
        snapshot: &RepositorySnapshot,
    ) -> Result<StoredRepositorySnapshot, StoreError> {
        let captured_at = OffsetDateTime::now_utc();
        let payload = serde_json::to_string(snapshot)
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let captured_at_text = captured_at
            .format(&Rfc3339)
            .map_err(|error| StoreError::Database(error.to_string()))?;

        sqlx::query(
            "INSERT INTO repo_snapshot (repo_id, schema_version, payload, captured_at) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT(repo_id) DO UPDATE SET \
                schema_version = excluded.schema_version, \
                payload = excluded.payload, \
                captured_at = excluded.captured_at",
        )
        .bind(repo_id.0.to_string())
        .bind(i64::from(schema_version))
        .bind(payload)
        .bind(captured_at_text)
        .execute(&self.pool)
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;

        Ok(StoredRepositorySnapshot {
            repo_id,
            snapshot: snapshot.clone(),
            captured_at,
            validated: true,
        })
    }
}

impl SqliteWorkspaceStore {
    async fn next_workspace_sort_order(&self) -> Result<i32, StoreError> {
        let row = sqlx::query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM workspaces")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(row.get("next"))
    }

    async fn next_repository_sort_order(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<i32, StoreError> {
        let row = sqlx::query(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM repositories WHERE workspace_id = ?",
        )
        .bind(workspace_id.0.to_string())
        .fetch_one(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(row.get("next"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fjord_domain::{CommitPage, GenerationSet, WorkingChanges};

    async fn store() -> SqliteWorkspaceStore {
        let pool = crate::connect(std::path::Path::new(":memory:"))
            .await
            .unwrap();
        SqliteWorkspaceStore::new(pool)
    }

    #[tokio::test]
    async fn create_then_list_round_trips() {
        let store = store().await;
        let created = store.create_workspace("Backend").await.unwrap();
        let all = store.list_workspaces().await.unwrap();
        assert_eq!(all, vec![created]);
    }

    #[tokio::test]
    async fn add_repository_scopes_to_its_workspace() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let other_ws = store.create_workspace("Frontend").await.unwrap();

        store
            .add_repository(
                ws.id,
                "api-gateway",
                std::path::Path::new("/repos/api-gateway"),
            )
            .await
            .unwrap();

        assert_eq!(store.list_repositories(ws.id).await.unwrap().len(), 1);
        assert_eq!(store.list_repositories(other_ws.id).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn get_repository_finds_it_by_id_alone() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let created = store
            .add_repository(
                ws.id,
                "api-gateway",
                std::path::Path::new("/repos/api-gateway"),
            )
            .await
            .unwrap();

        let fetched = store.get_repository(created.id).await.unwrap();
        assert_eq!(fetched, created);
    }

    #[tokio::test]
    async fn get_repository_reports_not_found() {
        let store = store().await;
        let result = store.get_repository(RepositoryId::new()).await;
        assert!(matches!(result, Err(StoreError::RepositoryNotFound(_))));
    }

    #[tokio::test]
    async fn duplicate_repository_has_a_typed_error() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let path = std::path::Path::new("/repos/api-gateway");
        store
            .add_repository(ws.id, "api-gateway", path)
            .await
            .unwrap();

        let result = store.add_repository(ws.id, "api-gateway", path).await;

        assert!(matches!(
            result,
            Err(StoreError::RepositoryAlreadyExists(duplicate)) if duplicate == path
        ));
    }

    #[tokio::test]
    async fn status_cache_defaults_then_round_trips_and_invalidates() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let repo = store
            .add_repository(
                ws.id,
                "api-gateway",
                std::path::Path::new("/repos/api-gateway"),
            )
            .await
            .unwrap();

        let empty = store.list_workspace_status(ws.id).await.unwrap();
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].repo_id, repo.id);
        assert_eq!(empty[0].status.dirty_count, 0);
        assert!(empty[0].last_synced_at.is_none());

        let status = RepoStatus {
            branch: Some("main".to_string()),
            ahead: 1,
            behind: 2,
            dirty_count: 3,
            has_conflict: true,
        };
        let cached = store.upsert_repo_status(repo.id, &status).await.unwrap();
        assert_eq!(cached.status, status);
        assert!(cached.last_synced_at.is_some());

        let listed = store.list_workspace_status(ws.id).await.unwrap();
        assert_eq!(listed[0].status, status);
        assert!(listed[0].last_synced_at.is_some());

        store.invalidate_repo_status(repo.id).await.unwrap();
        let invalidated = store.list_workspace_status(ws.id).await.unwrap();
        assert!(invalidated[0].last_synced_at.is_none());
    }

    fn repository_snapshot() -> RepositorySnapshot {
        RepositorySnapshot {
            status: RepoStatus {
                branch: Some("main".to_string()),
                ahead: 1,
                behind: 0,
                dirty_count: 2,
                has_conflict: false,
            },
            branches: Vec::new(),
            tags: Vec::new(),
            first_history_page: CommitPage {
                commits: Vec::new(),
                next_cursor: None,
            },
            working_changes: WorkingChanges::default(),
            generations: GenerationSet {
                working_tree: 3,
                refs: 4,
                history: 5,
                stash: 0,
                config: 1,
            },
        }
    }

    #[tokio::test]
    async fn repository_snapshot_round_trips_as_unvalidated_after_load() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let repo = store
            .add_repository(ws.id, "api", std::path::Path::new("/repos/api"))
            .await
            .unwrap();
        let snapshot = repository_snapshot();

        let captured = store
            .upsert_repository_snapshot(repo.id, 1, &snapshot)
            .await
            .unwrap();
        assert!(captured.validated);

        let loaded = store
            .load_repository_snapshot(repo.id, 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.snapshot, snapshot);
        assert_eq!(loaded.captured_at, captured.captured_at);
        assert!(!loaded.validated);
    }

    #[tokio::test]
    async fn repository_snapshot_rejects_an_unknown_schema_version() {
        let store = store().await;
        let ws = store.create_workspace("Backend").await.unwrap();
        let repo = store
            .add_repository(ws.id, "api", std::path::Path::new("/repos/api"))
            .await
            .unwrap();
        store
            .upsert_repository_snapshot(repo.id, 1, &repository_snapshot())
            .await
            .unwrap();

        sqlx::query("UPDATE repo_snapshot SET schema_version = 999 WHERE repo_id = ?")
            .bind(repo.id.0.to_string())
            .execute(&store.pool)
            .await
            .unwrap();

        assert!(store
            .load_repository_snapshot(repo.id, 1)
            .await
            .unwrap()
            .is_none());
    }
}
