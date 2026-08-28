//! Concrete, bounded facts for destructive-action confirmation.

use super::*;
use fjord_domain::{Consequence, Recoverability, ResetMode};
use fjord_ports::DestructiveActionFacts;
use std::collections::BTreeSet;

const BLOCKER_ACTION_UNSUPPORTED: &str = "destructive_action_unsupported";
const BLOCKER_CURRENT_BRANCH: &str = "current_branch_cannot_be_deleted";
const BLOCKER_OPERATION_NOT_IN_PROGRESS: &str = "operation_not_in_progress";
const BLOCKER_REF_NOT_FOUND: &str = "ref_not_found";
const BLOCKER_OPERATION_IN_PROGRESS: &str = "operation_already_in_progress";

pub(super) async fn facts(
    repo: &RepoPath,
    action: &DestructiveAction,
    sample_limit: u32,
) -> Result<DestructiveActionFacts, GitError> {
    let repo = repo.clone();
    let action = action.clone();
    let sample_limit = sample_limit.min(5) as usize;
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            assemble_facts(git, &repo, &action, sample_limit)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn assemble_facts(
    git: &git2::Repository,
    repo: &RepoPath,
    action: &DestructiveAction,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    match action {
        DestructiveAction::Reset { commit_id, mode } => {
            reset_facts(git, commit_id, *mode, sample_limit)
        }
        DestructiveAction::RecoveryRestore { commit_id } => {
            reset_facts(git, commit_id, ResetMode::Hard, sample_limit)
        }
        DestructiveAction::DeleteBranch { name } => delete_branch_facts(git, name, sample_limit),
        DestructiveAction::DeleteRemoteBranch { remote, branch } => {
            delete_remote_branch_facts(git, remote, branch, sample_limit)
        }
        DestructiveAction::DeleteTag { name } => delete_tag_facts(git, name),
        DestructiveAction::StashPop { id, .. } => stash_facts(git, id, true),
        DestructiveAction::StashDrop { id } => stash_facts(git, id, false),
        DestructiveAction::CheckoutDiscard { branch } => {
            checkout_discard_facts(git, branch, sample_limit)
        }
        DestructiveAction::AbortOperation => abort_facts(git, sample_limit),
        DestructiveAction::DeleteFile { path } => super::delete_file::facts(git, repo, path),
        DestructiveAction::Discard { .. } | DestructiveAction::ForceWithLease => {
            Ok(blocked(BLOCKER_ACTION_UNSUPPORTED))
        }
    }
}

fn reset_facts(
    git: &git2::Repository,
    target: &str,
    mode: ResetMode,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    let Some(target) = resolve_commit(git, target)? else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let (count, sample) = commits_between(git, head_id(git)?, target.id(), sample_limit)?;
    let dirty = dirty_facts(git, sample_limit)?;
    let mut consequences = Vec::new();
    if matches!(mode, ResetMode::Hard) {
        push_modified_consequences(&mut consequences, &dirty);
    } else if matches!(mode, ResetMode::Mixed) && dirty.staged_count > 0 {
        consequences.push(Consequence::StagedChangesDiscarded {
            count: dirty.staged_count,
        });
    }
    if count > 0 {
        consequences.push(Consequence::CommitsUnreachable { count, sample });
    }

    let loses_uncommitted_state = match mode {
        ResetMode::Hard => dirty.modified_count > 0 || dirty.staged_count > 0,
        ResetMode::Mixed => dirty.staged_count > 0,
        ResetMode::Soft => false,
    };
    Ok(DestructiveActionFacts {
        consequences,
        recoverable: if loses_uncommitted_state {
            Recoverability::NotRecoverable
        } else {
            Recoverability::Reflog
        },
        blockers: Vec::new(),
    })
}

fn delete_branch_facts(
    git: &git2::Repository,
    name: &str,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    let Ok(branch) = git.find_branch(name, git2::BranchType::Local) else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    if branch.is_head() {
        return Ok(blocked(BLOCKER_CURRENT_BRANCH));
    }
    let Some(target) = branch.get().target() else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let head = head_id(git)?;
    let merged = head
        .map(|head| git.graph_descendant_of(head, target))
        .transpose()
        .map_err(LocalGitBackend::map_git2_error)?
        .unwrap_or(false);
    let current = current_branch_name(git).unwrap_or_else(|| "HEAD".to_string());
    let (count, sample) = commits_between(git, Some(target), head.unwrap_or(target), sample_limit)?;
    let mut consequences = vec![Consequence::BranchDeleted {
        name: name.to_string(),
        unmerged_into: (!merged).then_some(current),
    }];
    if !merged && count > 0 {
        consequences.push(Consequence::CommitsUnreachable { count, sample });
    }
    Ok(not_recoverable(consequences))
}

fn delete_remote_branch_facts(
    git: &git2::Repository,
    remote: &str,
    branch: &str,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    let reference_name = format!("refs/remotes/{remote}/{branch}");
    let Ok(reference) = git.find_reference(&reference_name) else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let Some(target) = reference.target() else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let (count, sample) = commits_between(
        git,
        Some(target),
        head_id(git)?.unwrap_or(target),
        sample_limit,
    )?;
    let mut consequences = vec![Consequence::RemoteRefUpdated {
        remote: remote.to_string(),
        ref_name: format!("refs/heads/{branch}"),
        dropped_commits: count,
    }];
    if count > 0 {
        consequences.push(Consequence::CommitsUnreachable { count, sample });
    }
    Ok(not_recoverable(consequences))
}

fn delete_tag_facts(
    git: &git2::Repository,
    name: &str,
) -> Result<DestructiveActionFacts, GitError> {
    let Ok(reference) = git.find_reference(&format!("refs/tags/{name}")) else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let target_commit_id = reference
        .peel_to_commit()
        .ok()
        .map(|commit| CommitId(commit.id().to_string()));
    Ok(not_recoverable(vec![Consequence::TagDeleted {
        name: name.to_string(),
        target_commit_id,
    }]))
}

fn stash_facts(
    git: &git2::Repository,
    id: &fjord_domain::StashId,
    block_during_operation: bool,
) -> Result<DestructiveActionFacts, GitError> {
    let entry = super::stash::current_entry(git, id)?;
    let blockers = if block_during_operation
        && (git.state() != git2::RepositoryState::Clean || git.path().join("BISECT_LOG").exists())
    {
        vec![BLOCKER_OPERATION_IN_PROGRESS.to_string()]
    } else {
        Vec::new()
    };
    Ok(DestructiveActionFacts {
        consequences: vec![Consequence::StashEntryConsumed {
            id: entry.id,
            ref_name: entry.ref_name,
            title: entry.title,
            files_changed: entry.files_changed,
            base: entry.base,
            branch: entry.branch,
        }],
        recoverable: Recoverability::NotRecoverable,
        blockers,
    })
}

fn checkout_discard_facts(
    git: &git2::Repository,
    branch: &str,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    let Some(target) = resolve_commit(git, branch)? else {
        return Ok(blocked(BLOCKER_REF_NOT_FOUND));
    };
    let dirty = dirty_facts(git, sample_limit)?;
    let mut consequences = Vec::new();
    push_modified_consequences(&mut consequences, &dirty);
    let target_tree = target.tree().map_err(LocalGitBackend::map_git2_error)?;
    let deleted_untracked = dirty
        .untracked
        .iter()
        .filter(|path| target_tree.get_path(std::path::Path::new(path)).is_ok())
        .collect::<Vec<_>>();
    if !deleted_untracked.is_empty() {
        consequences.push(Consequence::UntrackedFilesDeleted {
            count: deleted_untracked.len() as u32,
            sample: deleted_untracked
                .into_iter()
                .take(sample_limit)
                .cloned()
                .collect(),
        });
    }
    Ok(not_recoverable(consequences))
}

fn abort_facts(
    git: &git2::Repository,
    sample_limit: usize,
) -> Result<DestructiveActionFacts, GitError> {
    let bisect_in_progress = git.path().join("BISECT_LOG").exists();
    if git.state() == git2::RepositoryState::Clean && !bisect_in_progress {
        return Ok(blocked(BLOCKER_OPERATION_NOT_IN_PROGRESS));
    }
    let dirty = dirty_facts(git, sample_limit)?;
    let mut consequences = Vec::new();
    push_modified_consequences(&mut consequences, &dirty);
    Ok(not_recoverable(consequences))
}

#[derive(Default)]
struct DirtyFacts {
    modified_count: u32,
    modified_sample: Vec<String>,
    staged_count: u32,
    untracked: BTreeSet<String>,
}

fn dirty_facts(git: &git2::Repository, sample_limit: usize) -> Result<DirtyFacts, GitError> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = git
        .statuses(Some(&mut options))
        .map_err(LocalGitBackend::map_git2_error)?;
    let mut modified = BTreeSet::new();
    let mut staged = BTreeSet::new();
    let mut untracked = BTreeSet::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or_default().to_string();
        if path.is_empty() {
            continue;
        }
        if status.contains(git2::Status::WT_NEW) {
            untracked.insert(path.clone());
        }
        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) || status.is_conflicted()
        {
            staged.insert(path.clone());
            modified.insert(path.clone());
        }
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        ) || status.is_conflicted()
        {
            modified.insert(path);
        }
    }
    Ok(DirtyFacts {
        modified_count: modified.len() as u32,
        modified_sample: modified.into_iter().take(sample_limit).collect(),
        staged_count: staged.len() as u32,
        untracked,
    })
}

fn push_modified_consequences(consequences: &mut Vec<Consequence>, dirty: &DirtyFacts) {
    if dirty.modified_count > 0 {
        consequences.push(Consequence::ModifiedFilesDiscarded {
            count: dirty.modified_count,
            sample: dirty.modified_sample.clone(),
        });
    }
    if dirty.staged_count > 0 {
        consequences.push(Consequence::StagedChangesDiscarded {
            count: dirty.staged_count,
        });
    }
}

fn commits_between(
    git: &git2::Repository,
    include: Option<git2::Oid>,
    exclude: git2::Oid,
    sample_limit: usize,
) -> Result<(u32, Vec<CommitSummary>), GitError> {
    let Some(include) = include else {
        return Ok((0, Vec::new()));
    };
    let mut walk = git.revwalk().map_err(LocalGitBackend::map_git2_error)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(LocalGitBackend::map_git2_error)?;
    walk.push(include)
        .map_err(LocalGitBackend::map_git2_error)?;
    walk.hide(exclude)
        .map_err(LocalGitBackend::map_git2_error)?;
    let mut count = 0_u32;
    let mut sample = Vec::with_capacity(sample_limit);
    for id in walk {
        let id = id.map_err(LocalGitBackend::map_git2_error)?;
        count = count.saturating_add(1);
        if sample.len() < sample_limit {
            sample.push(commit_summary(git, id)?);
        }
    }
    Ok((count, sample))
}

fn commit_summary(git: &git2::Repository, id: git2::Oid) -> Result<CommitSummary, GitError> {
    let commit = git
        .find_commit(id)
        .map_err(LocalGitBackend::map_git2_error)?;
    let author = commit.author();
    Ok(CommitSummary {
        id: CommitId(id.to_string()),
        parent_ids: commit
            .parent_ids()
            .map(|parent| CommitId(parent.to_string()))
            .collect(),
        message: commit
            .summary()
            .ok()
            .flatten()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect(),
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        authored_at: OffsetDateTime::from_unix_timestamp(author.when().seconds())
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
        refs: Vec::new(),
    })
}

fn resolve_commit<'repo>(
    git: &'repo git2::Repository,
    target: &str,
) -> Result<Option<git2::Commit<'repo>>, GitError> {
    match git.revparse_single(target) {
        Ok(object) => object
            .peel_to_commit()
            .map(Some)
            .map_err(LocalGitBackend::map_git2_error),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(LocalGitBackend::map_git2_error(error)),
    }
}

fn head_id(git: &git2::Repository) -> Result<Option<git2::Oid>, GitError> {
    match git.head() {
        Ok(head) => Ok(head.target()),
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(LocalGitBackend::map_git2_error(error)),
    }
}

fn current_branch_name(git: &git2::Repository) -> Option<String> {
    git.head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok().map(ToString::to_string))
}

fn blocked(reason: &str) -> DestructiveActionFacts {
    DestructiveActionFacts {
        consequences: Vec::new(),
        recoverable: Recoverability::NotRecoverable,
        blockers: vec![reason.to_string()],
    }
}

fn not_recoverable(consequences: Vec<Consequence>) -> DestructiveActionFacts {
    DestructiveActionFacts {
        consequences,
        recoverable: Recoverability::NotRecoverable,
        blockers: Vec::new(),
    }
}
