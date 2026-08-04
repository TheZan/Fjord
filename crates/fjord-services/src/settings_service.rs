use std::sync::Arc;

use fjord_domain::Settings;
use fjord_ports::{SettingsStore, StoreError};

/// The only use-case Phase 0 needs: read and update app settings. Everything
/// else in `fjord-services` depends only on `fjord-domain` + port traits
/// (docs/SDD.md §5.1), so this is intentionally the thinnest possible
/// example of that shape — later services (workspace management, bulk
/// operations, ...) follow the same pattern.
pub struct SettingsService {
    store: Arc<dyn SettingsStore>,
}

impl SettingsService {
    pub fn new(store: Arc<dyn SettingsStore>) -> Self {
        Self { store }
    }

    pub async fn get_settings(&self) -> Result<Settings, StoreError> {
        self.store.get_settings().await
    }

    pub async fn update_settings(&self, settings: Settings) -> Result<Settings, StoreError> {
        self.store.update_settings(&settings).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::Theme;
    use std::sync::Mutex;

    /// In-memory fake — this is the point of routing `fjord-services`
    /// through port traits instead of a concrete `fjord-db` type: no SQLite
    /// needed to test the use-case itself.
    struct FakeSettingsStore {
        settings: Mutex<Settings>,
    }

    #[async_trait]
    impl SettingsStore for FakeSettingsStore {
        async fn get_settings(&self) -> Result<Settings, StoreError> {
            Ok(self.settings.lock().unwrap().clone())
        }

        async fn update_settings(&self, settings: &Settings) -> Result<Settings, StoreError> {
            *self.settings.lock().unwrap() = settings.clone();
            Ok(settings.clone())
        }
    }

    #[tokio::test]
    async fn round_trips_a_theme_change() {
        let store = Arc::new(FakeSettingsStore {
            settings: Mutex::new(Settings::default()),
        });
        let service = SettingsService::new(store);

        let initial = service.get_settings().await.unwrap();
        assert_eq!(initial.theme, Theme::System);

        let updated = service
            .update_settings(Settings {
                theme: Theme::Dark,
                ..initial
            })
            .await
            .unwrap();
        assert_eq!(updated.theme, Theme::Dark);

        let fetched = service.get_settings().await.unwrap();
        assert_eq!(fetched.theme, Theme::Dark);
    }
}
