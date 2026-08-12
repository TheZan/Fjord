use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

use fjord_domain::{RepositoryId, WorkspaceId};
use fjord_ports::{GitOperationContext, GitProgress};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub const OPERATION_PROGRESS_EVENT: &str = "fjord-operation-progress";

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct OperationRegistry {
    inner: Mutex<HashMap<String, Arc<OperationState>>>,
}

#[derive(Default)]
pub struct OperationState {
    cancelled: AtomicBool,
    notify: Notify,
}

pub struct OperationGuard {
    id: String,
    registry: Arc<OperationRegistry>,
    state: Arc<OperationState>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Fetch,
    Pull,
    Push,
    Publish,
    CommitPush,
    BulkFetch,
    BulkPull,
}

impl OperationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Pull => "pull",
            Self::Push => "push",
            Self::Publish => "publish",
            Self::CommitPush => "commit-push",
            Self::BulkFetch => "bulk-fetch",
            Self::BulkPull => "bulk-pull",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OperationScope {
    Repo { repo_id: RepositoryId },
    Workspace { workspace_id: WorkspaceId },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationStatus {
    Started,
    Progress,
    RepoStarted,
    RepoFinished,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub operation_id: String,
    pub kind: OperationKind,
    pub scope: OperationScope,
    pub status: OperationStatus,
    pub repo_id: Option<RepositoryId>,
    pub completed: u32,
    pub total: u32,
    pub message: Option<String>,
    pub error: Option<String>,
}

impl OperationRegistry {
    pub fn next_id() -> String {
        let id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        format!("op-{id}")
    }

    pub fn begin(self: &Arc<Self>, operation_id: String) -> OperationGuard {
        let state = Arc::new(OperationState::default());
        self.inner
            .lock()
            .expect("operation registry lock should not be poisoned")
            .insert(operation_id.clone(), state.clone());

        OperationGuard {
            id: operation_id,
            registry: self.clone(),
            state,
        }
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let state = self
            .inner
            .lock()
            .expect("operation registry lock should not be poisoned")
            .get(operation_id)
            .cloned();

        if let Some(state) = state {
            state.cancel();
            true
        } else {
            false
        }
    }
}

impl OperationState {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

impl OperationGuard {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.state.cancelled().await;
    }

    pub fn git_context(
        &self,
        app: AppHandle,
        kind: OperationKind,
        scope: OperationScope,
        repo_id: RepositoryId,
    ) -> GitOperationContext {
        let operation_id = self.id.clone();
        let state = self.state.clone();
        GitOperationContext::new(
            move |progress: GitProgress| {
                emit_operation(
                    &app,
                    OperationProgress {
                        operation_id: operation_id.clone(),
                        kind,
                        scope: scope.clone(),
                        status: OperationStatus::Progress,
                        repo_id: Some(repo_id),
                        completed: progress.completed,
                        total: progress.total,
                        message: progress.message,
                        error: None,
                    },
                );
            },
            move || state.is_cancelled(),
        )
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut operations = self
            .registry
            .inner
            .lock()
            .expect("operation registry lock should not be poisoned");

        if operations
            .get(&self.id)
            .is_some_and(|state| Arc::ptr_eq(state, &self.state))
        {
            operations.remove(&self.id);
        }
    }
}

pub fn emit_operation(app: &AppHandle, progress: OperationProgress) {
    if let Err(error) = app.emit(OPERATION_PROGRESS_EVENT, &progress) {
        tracing::warn!(error = %error, "failed to emit operation progress event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_marks_registered_operation() {
        let registry = Arc::new(OperationRegistry::default());
        let operation = registry.begin("operation-1".to_string());

        assert!(!operation.is_cancelled());
        assert!(registry.cancel("operation-1"));
        assert!(operation.is_cancelled());
    }

    #[test]
    fn dropped_operation_is_no_longer_cancellable() {
        let registry = Arc::new(OperationRegistry::default());
        let operation = registry.begin("operation-1".to_string());
        drop(operation);

        assert!(!registry.cancel("operation-1"));
    }
}
