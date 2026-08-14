//! Per-repository invalidation generations and mutation-to-domain mapping.

use std::sync::Mutex;

pub use fjord_domain::GenerationSet;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GenerationMask {
    pub working_tree: bool,
    pub refs: bool,
    pub history: bool,
    pub stash: bool,
    pub config: bool,
}

impl GenerationMask {
    pub const NONE: Self = Self::new(false, false, false, false, false);
    pub const WORKING_TREE: Self = Self::new(true, false, false, false, false);
    pub const REFS: Self = Self::new(false, true, false, false, false);
    pub const REFS_HISTORY: Self = Self::new(false, true, true, false, false);
    pub const WORKING_REFS: Self = Self::new(true, true, false, false, false);
    pub const WORKING_REFS_HISTORY: Self = Self::new(true, true, true, false, false);
    pub const WORKING_STASH: Self = Self::new(true, false, false, true, false);
    pub const CONFIG: Self = Self::new(false, false, false, false, true);
    pub const REFS_CONFIG: Self = Self::new(false, true, false, false, true);
    pub const REFS_HISTORY_CONFIG: Self = Self::new(false, true, true, false, true);

    pub const fn new(
        working_tree: bool,
        refs: bool,
        history: bool,
        stash: bool,
        config: bool,
    ) -> Self {
        Self {
            working_tree,
            refs,
            history,
            stash,
            config,
        }
    }

    pub(crate) fn merge(&mut self, other: Self) {
        self.working_tree |= other.working_tree;
        self.refs |= other.refs;
        self.history |= other.history;
        self.stash |= other.stash;
        self.config |= other.config;
    }
}

fn bump_set(generations: &mut GenerationSet, mask: GenerationMask) {
    if mask.working_tree {
        generations.working_tree = generations.working_tree.saturating_add(1);
    }
    if mask.refs {
        generations.refs = generations.refs.saturating_add(1);
    }
    if mask.history {
        generations.history = generations.history.saturating_add(1);
    }
    if mask.stash {
        generations.stash = generations.stash.saturating_add(1);
    }
    if mask.config {
        generations.config = generations.config.saturating_add(1);
    }
}

fn matches(current: GenerationSet, other: GenerationSet, mask: GenerationMask) -> bool {
    (!mask.working_tree || current.working_tree == other.working_tree)
        && (!mask.refs || current.refs == other.refs)
        && (!mask.history || current.history == other.history)
        && (!mask.stash || current.stash == other.stash)
        && (!mask.config || current.config == other.config)
}

/// Generation clock used by a repository runtime. Cache publication executes
/// under the same lock as bumps, making the comparison-and-store indivisible.
#[derive(Debug, Default)]
pub struct GenerationClock {
    current: Mutex<GenerationSet>,
}

impl GenerationClock {
    pub fn snapshot(&self) -> GenerationSet {
        *self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn bump(&self, mask: GenerationMask) {
        bump_set(
            &mut self
                .current
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            mask,
        );
    }

    /// Publishes a computed cache value only while its dependency generations
    /// still equal the snapshot observed before computation.
    pub fn commit_if_current<T>(
        &self,
        expected: GenerationSet,
        dependencies: GenerationMask,
        publish: impl FnOnce() -> T,
    ) -> Option<T> {
        let current = self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        matches(*current, expected, dependencies).then(publish)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MutationKind {
    Checkout,
    CreateBranch { checkout: bool },
    CreateBranchAt { checkout: bool },
    RenameBranch,
    DeleteBranch,
    SetUpstream,
    CreateTag,
    DeleteTag,
    CherryPick,
    Revert,
    Reset { touches_working_tree: bool },
    StashPush,
    StashPop,
    Stage,
    Unstage,
    Discard,
    Commit,
    IntegrateUpstream,
    Fetch,
    Push,
    PublishBranch,
    DeleteRemoteBranch,
    OperationStep,
}

pub(crate) const fn mutation_mask(mutation: MutationKind) -> GenerationMask {
    match mutation {
        MutationKind::Checkout => GenerationMask::WORKING_REFS,
        MutationKind::CreateBranch { checkout: false } => GenerationMask::REFS,
        MutationKind::CreateBranch { checkout: true } => GenerationMask::WORKING_REFS,
        MutationKind::CreateBranchAt { checkout: false } => GenerationMask::REFS_HISTORY,
        MutationKind::CreateBranchAt { checkout: true } => GenerationMask::WORKING_REFS_HISTORY,
        MutationKind::RenameBranch => GenerationMask::REFS,
        MutationKind::SetUpstream => GenerationMask::REFS_CONFIG,
        MutationKind::DeleteBranch | MutationKind::CreateTag | MutationKind::DeleteTag => {
            GenerationMask::REFS_HISTORY
        }
        MutationKind::CherryPick
        | MutationKind::Revert
        | MutationKind::Commit
        | MutationKind::IntegrateUpstream => GenerationMask::WORKING_REFS_HISTORY,
        MutationKind::Reset {
            touches_working_tree: false,
        } => GenerationMask::REFS_HISTORY,
        MutationKind::Reset {
            touches_working_tree: true,
        } => GenerationMask::WORKING_REFS_HISTORY,
        MutationKind::StashPush | MutationKind::StashPop => GenerationMask::WORKING_STASH,
        MutationKind::Stage | MutationKind::Unstage | MutationKind::Discard => {
            GenerationMask::WORKING_TREE
        }
        MutationKind::Fetch | MutationKind::Push | MutationKind::DeleteRemoteBranch => {
            GenerationMask::REFS_HISTORY
        }
        MutationKind::PublishBranch => GenerationMask::REFS_HISTORY_CONFIG,
        MutationKind::OperationStep => GenerationMask::WORKING_REFS_HISTORY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mutation_bumps_exactly_its_observable_domains() {
        let cases = [
            (MutationKind::Checkout, GenerationMask::WORKING_REFS),
            (
                MutationKind::CreateBranch { checkout: false },
                GenerationMask::REFS,
            ),
            (
                MutationKind::CreateBranch { checkout: true },
                GenerationMask::WORKING_REFS,
            ),
            (
                MutationKind::CreateBranchAt { checkout: false },
                GenerationMask::REFS_HISTORY,
            ),
            (
                MutationKind::CreateBranchAt { checkout: true },
                GenerationMask::WORKING_REFS_HISTORY,
            ),
            (MutationKind::RenameBranch, GenerationMask::REFS),
            (MutationKind::SetUpstream, GenerationMask::REFS_CONFIG),
            (MutationKind::DeleteBranch, GenerationMask::REFS_HISTORY),
            (MutationKind::CreateTag, GenerationMask::REFS_HISTORY),
            (MutationKind::DeleteTag, GenerationMask::REFS_HISTORY),
            (
                MutationKind::CherryPick,
                GenerationMask::WORKING_REFS_HISTORY,
            ),
            (MutationKind::Revert, GenerationMask::WORKING_REFS_HISTORY),
            (
                MutationKind::Reset {
                    touches_working_tree: false,
                },
                GenerationMask::REFS_HISTORY,
            ),
            (
                MutationKind::Reset {
                    touches_working_tree: true,
                },
                GenerationMask::WORKING_REFS_HISTORY,
            ),
            (MutationKind::StashPush, GenerationMask::WORKING_STASH),
            (MutationKind::StashPop, GenerationMask::WORKING_STASH),
            (MutationKind::Stage, GenerationMask::WORKING_TREE),
            (MutationKind::Unstage, GenerationMask::WORKING_TREE),
            (MutationKind::Discard, GenerationMask::WORKING_TREE),
            (MutationKind::Commit, GenerationMask::WORKING_REFS_HISTORY),
            (
                MutationKind::IntegrateUpstream,
                GenerationMask::WORKING_REFS_HISTORY,
            ),
            (MutationKind::Fetch, GenerationMask::REFS_HISTORY),
            (MutationKind::Push, GenerationMask::REFS_HISTORY),
            (
                MutationKind::PublishBranch,
                GenerationMask::REFS_HISTORY_CONFIG,
            ),
            (
                MutationKind::OperationStep,
                GenerationMask::WORKING_REFS_HISTORY,
            ),
            (
                MutationKind::DeleteRemoteBranch,
                GenerationMask::REFS_HISTORY,
            ),
        ];

        for (mutation, expected) in cases {
            assert_eq!(mutation_mask(mutation), expected, "{mutation:?}");
            let mut generations = GenerationSet::default();
            bump_set(&mut generations, mutation_mask(mutation));
            assert_eq!(
                generations,
                GenerationSet {
                    working_tree: u64::from(expected.working_tree),
                    refs: u64::from(expected.refs),
                    history: u64::from(expected.history),
                    stash: u64::from(expected.stash),
                    config: u64::from(expected.config),
                },
                "{mutation:?}"
            );
        }
    }

    #[test]
    fn losing_cache_write_is_discarded_after_a_generation_bump() {
        let clock = GenerationClock::default();
        let expected = clock.snapshot();
        clock.bump(GenerationMask::WORKING_TREE);
        let mut published = false;

        let result = clock.commit_if_current(expected, GenerationMask::WORKING_TREE, || {
            published = true;
            "stale"
        });

        assert_eq!(result, None);
        assert!(!published);
    }
}
