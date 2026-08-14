use async_trait::async_trait;
use fjord_domain::{UiState, UI_STATE_VERSION};
use fjord_ports::{StoreError, UiStateStore};
use sqlx::{Row, SqlitePool};
use time::OffsetDateTime;

pub struct SqliteUiStateStore {
    pool: SqlitePool,
}

impl SqliteUiStateStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl UiStateStore for SqliteUiStateStore {
    async fn get_ui_state(&self) -> Result<UiState, StoreError> {
        let row = sqlx::query("SELECT version, payload FROM ui_state WHERE id = 1")
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let Some(row) = row else {
            return Ok(UiState::default());
        };
        if row.get::<i64, _>("version") != i64::from(UI_STATE_VERSION) {
            return Ok(UiState::default());
        }
        let payload = row.get::<String, _>("payload");
        let state = serde_json::from_str::<UiState>(&payload).unwrap_or_default();
        if state.version != UI_STATE_VERSION {
            return Ok(UiState::default());
        }
        Ok(state)
    }

    async fn update_ui_state(&self, state: &UiState) -> Result<UiState, StoreError> {
        let mut state = state.clone();
        state.version = UI_STATE_VERSION;
        let payload = serde_json::to_string(&state)
            .map_err(|error| StoreError::Database(error.to_string()))?;
        sqlx::query(
            "INSERT INTO ui_state (id, version, payload, updated_at) VALUES (1, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, \
             payload = excluded.payload, updated_at = excluded.updated_at",
        )
        .bind(i64::from(UI_STATE_VERSION))
        .bind(payload)
        .bind(OffsetDateTime::now_utc().to_string())
        .execute(&self.pool)
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> SqliteUiStateStore {
        let pool = crate::connect(std::path::Path::new(":memory:"))
            .await
            .unwrap();
        SqliteUiStateStore::new(pool)
    }

    #[tokio::test]
    async fn round_trips_ui_state_and_ignores_unknown_payload_keys() {
        let store = store().await;
        let mut state = UiState::default();
        state.repo.tree_width = Some(278.0);
        store.update_ui_state(&state).await.unwrap();
        sqlx::query("UPDATE ui_state SET payload = json_set(payload, '$.futureKey', 42)")
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(store.get_ui_state().await.unwrap(), state);
    }

    #[tokio::test]
    async fn rejects_an_unknown_ui_state_version() {
        let store = store().await;
        store.update_ui_state(&UiState::default()).await.unwrap();
        sqlx::query("UPDATE ui_state SET payload = json_set(payload, '$.version', 999)")
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(store.get_ui_state().await.unwrap(), UiState::default());
    }

    #[tokio::test]
    async fn rejects_an_unknown_schema_version() {
        let store = store().await;
        store.update_ui_state(&UiState::default()).await.unwrap();
        sqlx::query("UPDATE ui_state SET version = 999")
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(store.get_ui_state().await.unwrap(), UiState::default());
    }
}
