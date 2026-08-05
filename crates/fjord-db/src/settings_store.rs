use async_trait::async_trait;
use fjord_domain::{Settings, Theme};
use fjord_ports::{SettingsStore, StoreError};
use sqlx::{Row, SqlitePool};
use time::OffsetDateTime;

pub struct SqliteSettingsStore {
    pool: SqlitePool,
}

impl SqliteSettingsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn theme_to_str(theme: Theme) -> &'static str {
    match theme {
        Theme::Light => "light",
        Theme::Dark => "dark",
        Theme::System => "system",
    }
}

fn theme_from_str(s: &str) -> Theme {
    match s {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    }
}

#[async_trait]
impl SettingsStore for SqliteSettingsStore {
    async fn get_settings(&self) -> Result<Settings, StoreError> {
        let row = sqlx::query("SELECT locale, theme, default_ide FROM settings WHERE id = 1")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(Settings {
            locale: row.get::<String, _>("locale"),
            theme: theme_from_str(&row.get::<String, _>("theme")),
            default_ide: row.get::<Option<String>, _>("default_ide"),
        })
    }

    async fn update_settings(&self, settings: &Settings) -> Result<Settings, StoreError> {
        sqlx::query(
            "UPDATE settings SET locale = ?, theme = ?, default_ide = ?, updated_at = ? WHERE id = 1",
        )
        .bind(&settings.locale)
        .bind(theme_to_str(settings.theme))
        .bind(&settings.default_ide)
        .bind(OffsetDateTime::now_utc().to_string())
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

        Ok(settings.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn in_memory_pool() -> SqlitePool {
        let pool = crate::connect(std::path::Path::new(":memory:"))
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn defaults_to_system_theme_and_english() {
        let store = SqliteSettingsStore::new(in_memory_pool().await);
        let settings = store.get_settings().await.unwrap();
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.locale, "en");
    }

    #[tokio::test]
    async fn update_persists() {
        let store = SqliteSettingsStore::new(in_memory_pool().await);
        let mut settings = store.get_settings().await.unwrap();
        settings.theme = Theme::Dark;
        settings.locale = "ru".to_string();
        store.update_settings(&settings).await.unwrap();

        let fetched = store.get_settings().await.unwrap();
        assert_eq!(fetched.theme, Theme::Dark);
        assert_eq!(fetched.locale, "ru");
    }
}
