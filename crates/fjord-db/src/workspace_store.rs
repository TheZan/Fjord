use std::path::PathBuf;
use std::str::FromStr;

use async_trait::async_trait;
use fjord_domain::{RepositoryEntry, RepositoryId, Workspace, WorkspaceId};
use fjord_ports::{StoreError, WorkspaceStore};
use sqlx::{Row, SqlitePool};
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

        tx.commit().await.map_err(|e| StoreError::Database(e.to_string()))
    }

    async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id.0.to_string())
            .execute(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(())
    }

    async fn list_repositories(&self, workspace_id: WorkspaceId) -> Result<Vec<RepositoryEntry>, StoreError> {
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
        .map_err(|e| StoreError::Database(e.to_string()))?;

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
}

impl SqliteWorkspaceStore {
    async fn next_workspace_sort_order(&self) -> Result<i32, StoreError> {
        let row = sqlx::query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM workspaces")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(row.get("next"))
    }

    async fn next_repository_sort_order(&self, workspace_id: WorkspaceId) -> Result<i32, StoreError> {
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

    async fn store() -> SqliteWorkspaceStore {
        let pool = crate::connect(std::path::Path::new(":memory:")).await.unwrap();
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
            .add_repository(ws.id, "api-gateway", std::path::Path::new("/repos/api-gateway"))
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
            .add_repository(ws.id, "api-gateway", std::path::Path::new("/repos/api-gateway"))
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
}
