use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fjord_domain::{DestructiveAction, GenerationSet, PatchSelection};
use fjord_ports::{ForcePushPlan, GitError, RepoPath};
use uuid::Uuid;

pub(super) const DEFAULT_CONFIRMATION_TTL: Duration = Duration::from_secs(120);

pub(super) struct DestructiveConfirmationStore {
    entries: Mutex<HashMap<String, PendingConfirmation>>,
    ttl: Duration,
}

struct PendingConfirmation {
    repo: PathBuf,
    action: DestructiveAction,
    binding: ConfirmationBinding,
    generations: GenerationSet,
    expires_at: Instant,
}

enum ConfirmationBinding {
    Discard(PatchSelection),
    ForcePush(ForcePushPlan),
    Action,
}

impl DestructiveConfirmationStore {
    pub(super) fn new(ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    pub(super) fn issue(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        selection: &PatchSelection,
        generations: GenerationSet,
    ) -> Result<String, GitError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().map_err(|_| GitError::PreflightStale)?;
        entries.retain(|_, pending| pending.expires_at > now);

        let token = Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            PendingConfirmation {
                repo: repository_key(repo),
                action: action.clone(),
                binding: ConfirmationBinding::Discard(selection.clone()),
                generations,
                expires_at: now + self.ttl,
            },
        );
        Ok(token)
    }

    /// Removes the token before validating its binding. A failed attempt is
    /// therefore terminal too: callers cannot probe or replay a confirmation.
    pub(super) fn consume(
        &self,
        token: &str,
        repo: &RepoPath,
        action: &DestructiveAction,
        selection: &PatchSelection,
        generations: GenerationSet,
    ) -> Result<(), GitError> {
        let pending = self
            .entries
            .lock()
            .map_err(|_| GitError::PreflightStale)?
            .remove(token)
            .ok_or(GitError::PreflightStale)?;

        if Instant::now() >= pending.expires_at
            || pending.repo != repository_key(repo)
            || pending.action != *action
            || !matches!(pending.binding, ConfirmationBinding::Discard(ref pending_selection) if pending_selection == selection)
            || pending.generations != generations
        {
            return Err(GitError::PreflightStale);
        }
        Ok(())
    }

    pub(super) fn issue_force_push(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        plan: &ForcePushPlan,
        generations: GenerationSet,
    ) -> Result<String, GitError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().map_err(|_| GitError::PreflightStale)?;
        entries.retain(|_, pending| pending.expires_at > now);

        let token = Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            PendingConfirmation {
                repo: repository_key(repo),
                action: action.clone(),
                binding: ConfirmationBinding::ForcePush(plan.clone()),
                generations,
                expires_at: now + self.ttl,
            },
        );
        Ok(token)
    }

    pub(super) fn issue_action(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        generations: GenerationSet,
    ) -> Result<String, GitError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().map_err(|_| GitError::PreflightStale)?;
        entries.retain(|_, pending| pending.expires_at > now);

        let token = Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            PendingConfirmation {
                repo: repository_key(repo),
                action: action.clone(),
                binding: ConfirmationBinding::Action,
                generations,
                expires_at: now + self.ttl,
            },
        );
        Ok(token)
    }

    pub(super) fn consume_force_push(
        &self,
        token: &str,
        repo: &RepoPath,
        action: &DestructiveAction,
        current_plan: &ForcePushPlan,
        generations: GenerationSet,
    ) -> Result<ForcePushPlan, GitError> {
        let pending = self
            .entries
            .lock()
            .map_err(|_| GitError::PreflightStale)?
            .remove(token)
            .ok_or(GitError::PreflightStale)?;
        let ConfirmationBinding::ForcePush(plan) = pending.binding else {
            return Err(GitError::PreflightStale);
        };
        if Instant::now() >= pending.expires_at
            || pending.repo != repository_key(repo)
            || pending.action != *action
            || pending.generations != generations
            || plan != *current_plan
        {
            return Err(GitError::PreflightStale);
        }
        Ok(plan)
    }
}

fn repository_key(repo: &RepoPath) -> PathBuf {
    std::fs::canonicalize(&repo.0).unwrap_or_else(|_| repo.0.clone())
}
