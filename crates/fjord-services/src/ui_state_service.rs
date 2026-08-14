use std::sync::Arc;

use fjord_domain::{UiState, UiStatePatch};
use fjord_ports::{StoreError, UiStateStore};

pub struct UiStateService {
    store: Arc<dyn UiStateStore>,
}

impl UiStateService {
    pub fn new(store: Arc<dyn UiStateStore>) -> Self {
        Self { store }
    }

    pub async fn get_ui_state(&self) -> Result<UiState, StoreError> {
        self.store.get_ui_state().await
    }

    pub async fn update_ui_state(&self, patch: UiStatePatch) -> Result<UiState, StoreError> {
        let mut state = self.store.get_ui_state().await?;
        state.apply(patch);
        self.store.update_ui_state(&state).await
    }
}
