use std::sync::Arc;

use fjord_domain::{is_valid_diff_tool_name, Settings};
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
        validate_diff_tool(settings.diff_tool.as_deref())?;
        self.store.update_settings(&settings).await
    }
}

/// Fjord stores a Git difftool **name** only — never a path, shell command,
/// or command line (docs/specs/working-tree-and-diff.md §6.4). A value
/// containing a path separator, whitespace, a quote, or a shell
/// metacharacter is rejected outright: only a name Git's own `--tool=<name>`
/// resolution would accept can ever be persisted here.
fn validate_diff_tool(name: Option<&str>) -> Result<(), StoreError> {
    let Some(name) = name else { return Ok(()) };
    if is_valid_diff_tool_name(name) {
        Ok(())
    } else {
        Err(StoreError::InvalidSetting("diff_tool_name_invalid"))
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

    #[tokio::test]
    async fn accepts_a_plain_diff_tool_name_and_clearing_it() {
        let store = Arc::new(FakeSettingsStore {
            settings: Mutex::new(Settings::default()),
        });
        let service = SettingsService::new(store);
        let initial = service.get_settings().await.unwrap();

        let updated = service
            .update_settings(Settings {
                diff_tool: Some("meld".to_string()),
                ..initial.clone()
            })
            .await
            .unwrap();
        assert_eq!(updated.diff_tool.as_deref(), Some("meld"));

        let cleared = service
            .update_settings(Settings {
                diff_tool: None,
                ..initial
            })
            .await
            .unwrap();
        assert_eq!(cleared.diff_tool, None);
    }

    #[tokio::test]
    async fn rejects_a_diff_tool_value_that_is_a_path_a_command_or_contains_shell_metacharacters() {
        let store = Arc::new(FakeSettingsStore {
            settings: Mutex::new(Settings::default()),
        });
        let service = SettingsService::new(store);
        let initial = service.get_settings().await.unwrap();

        for invalid in [
            "/usr/bin/meld",
            "C:\\Tools\\meld.exe",
            "meld --diff",
            "meld; rm -rf /",
            "meld$(whoami)",
            "\"meld\"",
            "'meld'",
            "meld\nother",
            "meld\rother",
            "meld\tother",
            "",
        ] {
            let result = service
                .update_settings(Settings {
                    diff_tool: Some(invalid.to_string()),
                    ..initial.clone()
                })
                .await;
            assert!(
                matches!(
                    result,
                    Err(StoreError::InvalidSetting("diff_tool_name_invalid"))
                ),
                "expected {invalid:?} to be rejected, got {result:?}"
            );
        }
    }
}
