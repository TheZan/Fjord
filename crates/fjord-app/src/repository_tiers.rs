use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use fjord_domain::{RepositoryEntry, RepositoryId, WorkspaceId};

pub(crate) const DEFAULT_MAX_HOT: usize = 3;
pub(crate) const DEFAULT_MAX_WARM: usize = 32;
pub(crate) const DEFAULT_HOT_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepositoryTier {
    Hot,
    Warm,
    Cold,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TierConfig {
    pub max_hot: usize,
    pub max_warm: usize,
    pub hot_idle: Duration,
}

impl Default for TierConfig {
    fn default() -> Self {
        Self {
            max_hot: positive_env_usize("FJORD_MAX_HOT_REPOSITORIES").unwrap_or(DEFAULT_MAX_HOT),
            max_warm: positive_env_usize("FJORD_MAX_WARM_REPOSITORIES").unwrap_or(DEFAULT_MAX_WARM),
            hot_idle: DEFAULT_HOT_IDLE,
        }
    }
}

fn positive_env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()?
        .parse()
        .ok()
        .filter(|value| *value > 0)
}

pub(crate) struct RepositoryTierPolicy {
    config: TierConfig,
    active_workspace: Option<WorkspaceId>,
    active_repository: Option<RepositoryId>,
    visits: VecDeque<(RepositoryId, Instant)>,
}

impl Default for RepositoryTierPolicy {
    fn default() -> Self {
        Self::new(TierConfig::default())
    }
}

impl RepositoryTierPolicy {
    pub(crate) fn new(config: TierConfig) -> Self {
        Self {
            config,
            active_workspace: None,
            active_repository: None,
            visits: VecDeque::new(),
        }
    }

    pub(crate) fn activate(
        &mut self,
        workspace: Option<WorkspaceId>,
        repository: Option<RepositoryId>,
        now: Instant,
    ) {
        self.active_workspace = workspace;
        self.active_repository = repository;
        if let Some(repository) = repository {
            self.visits.retain(|(id, _)| *id != repository);
            self.visits.push_front((repository, now));
        }
    }

    pub(crate) fn remove(&mut self, repository: RepositoryId) {
        self.visits.retain(|(id, _)| *id != repository);
        if self.active_repository == Some(repository) {
            self.active_repository = None;
        }
    }

    pub(crate) fn tiers(
        &mut self,
        repositories: &[RepositoryEntry],
        now: Instant,
    ) -> HashMap<RepositoryId, RepositoryTier> {
        let known = repositories
            .iter()
            .map(|repository| repository.id)
            .collect::<HashSet<_>>();
        self.visits.retain(|(id, visited)| {
            known.contains(id) && now.saturating_duration_since(*visited) <= self.config.hot_idle
        });

        let mut hot = Vec::new();
        if let Some(active) = self.active_repository.filter(|id| known.contains(id)) {
            hot.push(active);
        }
        for (id, _) in &self.visits {
            if hot.len() >= self.config.max_hot {
                break;
            }
            if !hot.contains(id) {
                hot.push(*id);
            }
        }
        hot.truncate(self.config.max_hot);
        let hot = hot.into_iter().collect::<HashSet<_>>();

        let mut warm = HashSet::new();
        if let Some(workspace) = self.active_workspace {
            // Recent repositories win when a workspace contains more entries
            // than the warm budget; stable store order breaks remaining ties.
            for (id, _) in &self.visits {
                if warm.len() >= self.config.max_warm {
                    break;
                }
                if !hot.contains(id)
                    && repositories.iter().any(|repository| {
                        repository.id == *id && repository.workspace_id == workspace
                    })
                {
                    warm.insert(*id);
                }
            }
            for repository in repositories {
                if warm.len() >= self.config.max_warm {
                    break;
                }
                if repository.workspace_id == workspace && !hot.contains(&repository.id) {
                    warm.insert(repository.id);
                }
            }
        }

        repositories
            .iter()
            .map(|repository| {
                let tier = if hot.contains(&repository.id) {
                    RepositoryTier::Hot
                } else if warm.contains(&repository.id) {
                    RepositoryTier::Warm
                } else {
                    RepositoryTier::Cold
                };
                (repository.id, tier)
            })
            .collect()
    }

    pub(crate) fn hot_idle(&self) -> Duration {
        self.config.hot_idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn repository(workspace_id: WorkspaceId, index: usize) -> RepositoryEntry {
        RepositoryEntry {
            id: RepositoryId(Uuid::from_u128(index as u128 + 1)),
            workspace_id,
            name: format!("repo-{index}"),
            path: PathBuf::from(format!("repo-{index}")),
            sort_order: index as i32,
        }
    }

    #[test]
    fn scripted_visits_respect_tier_budgets_and_idle_demotion() {
        let workspace = WorkspaceId(Uuid::from_u128(500));
        let other_workspace = WorkspaceId(Uuid::from_u128(501));
        let mut repositories = (0..40)
            .map(|index| repository(workspace, index))
            .collect::<Vec<_>>();
        repositories.extend((40..45).map(|index| repository(other_workspace, index)));
        let start = Instant::now();
        let mut policy = RepositoryTierPolicy::new(TierConfig {
            max_hot: 3,
            max_warm: 32,
            hot_idle: Duration::from_secs(60),
        });

        for (seconds, repository) in repositories.iter().take(4).enumerate() {
            policy.activate(
                Some(workspace),
                Some(repository.id),
                start + Duration::from_secs(seconds as u64),
            );
        }
        let tiers = policy.tiers(&repositories, start + Duration::from_secs(4));
        assert_eq!(count(&tiers, RepositoryTier::Hot), 3);
        assert_eq!(count(&tiers, RepositoryTier::Warm), 32);
        assert_eq!(count(&tiers, RepositoryTier::Cold), 10);

        let tiers = policy.tiers(&repositories, start + Duration::from_secs(65));
        assert_eq!(
            count(&tiers, RepositoryTier::Hot),
            1,
            "the active repository stays hot"
        );
        assert_eq!(count(&tiers, RepositoryTier::Warm), 32);
        assert_eq!(count(&tiers, RepositoryTier::Cold), 12);
    }

    fn count(tiers: &HashMap<RepositoryId, RepositoryTier>, tier: RepositoryTier) -> usize {
        tiers
            .values()
            .filter(|candidate| **candidate == tier)
            .count()
    }
}
