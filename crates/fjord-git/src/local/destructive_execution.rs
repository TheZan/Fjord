//! Confirmation-bound execution for local destructive actions.

use super::*;
use fjord_domain::{
    DestructiveAction, DestructiveExecutionResult, GenerationSet, ResetMode, StashApplyResult,
};
use fjord_ports::{GitError, GitOperationContext, RepoPath};

pub(super) struct ExecutionDependencies<'a> {
    pub commands: &'a GitCommandFactory,
    pub confirmations: &'a std::sync::Arc<destructive_confirmation::DestructiveConfirmationStore>,
    pub origins: &'a std::sync::Arc<operation_state::OperationOriginTracker>,
}

pub(super) async fn execute(
    dependencies: ExecutionDependencies<'_>,
    repo: &RepoPath,
    action: &DestructiveAction,
    expected_generations: GenerationSet,
    confirmation_token: &str,
    context: GitOperationContext,
) -> Result<DestructiveExecutionResult, GitError> {
    let repo = repo.clone();
    let action = action.clone();
    let commands = dependencies.commands.clone();
    let confirmations = dependencies.confirmations.clone();
    let origins = dependencies.origins.clone();
    let confirmation_token = confirmation_token.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;

    if runtime::generations(&repo)? != expected_generations {
        return Err(GitError::PreflightStale);
    }
    confirmations.consume_action(&confirmation_token, &repo, &action, expected_generations)?;
    if context.is_cancelled() {
        return Err(GitError::Cancelled);
    }

    if matches!(action, DestructiveAction::AbortOperation) {
        return operation_control::run_locked(
            commands,
            origins,
            &repo,
            operation_control::OperationAction::Abort,
            context,
        )
        .await
        .map(|state| DestructiveExecutionResult::OperationState { state });
    }

    if let DestructiveAction::DeleteFile { path } = &action {
        let delete_repo = repo.clone();
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            LocalGitBackend::with_runtime_git2(&delete_repo, |git| {
                super::delete_file::execute(git, &delete_repo, &path)
            })
        })
        .await
        .map_err(|error| GitError::Git2(error.to_string()))??;
        runtime::bump_mutation(&repo, MutationKind::DeleteFile);
        return Ok(DestructiveExecutionResult::Completed);
    }

    if let DestructiveAction::StashPop { id, restore_index } = &action {
        let pop_repo = repo.clone();
        let id = id.clone();
        let restore_index = *restore_index;
        let popped = tokio::task::spawn_blocking(move || {
            super::stash::apply_locked(
                &commands,
                &pop_repo,
                &id,
                restore_index,
                super::stash::ApplyMode::Pop,
            )
        })
        .await
        .map_err(|error| GitError::Git2(error.to_string()))??;
        runtime::bump_mutation(&repo, MutationKind::StashPop);
        return Ok(DestructiveExecutionResult::StashApply {
            result: StashApplyResult {
                outcome: popped.outcome,
                entry_removed: popped.entry_removed,
                generations: runtime::generations(&repo)?,
            },
        });
    }

    if let DestructiveAction::StashDrop { id } = &action {
        let drop_repo = repo.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || super::stash::drop_locked(&commands, &drop_repo, &id))
            .await
            .map_err(|error| GitError::Git2(error.to_string()))??;
        runtime::bump_mutation(&repo, MutationKind::StashDrop);
        return Ok(DestructiveExecutionResult::Completed);
    }

    let (args, mutation) = command(&action)?;
    let command_repo = repo.clone();
    let result = tokio::task::spawn_blocking(move || {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        LocalGitBackend::run_local_git(&commands, &command_repo, &args)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?;

    // Once Git was launched, invalidate conservatively even on failure: stash
    // pop and checkout can leave observable worktree state before returning an
    // error.
    runtime::bump_mutation(&repo, mutation);
    result?;
    Ok(DestructiveExecutionResult::Completed)
}

fn command(action: &DestructiveAction) -> Result<(Vec<String>, MutationKind), GitError> {
    let command = match action {
        DestructiveAction::Reset { commit_id, mode } => {
            let flag = match mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Hard => "--hard",
            };
            (
                vec!["reset".into(), flag.into(), commit_id.clone()],
                MutationKind::Reset {
                    touches_working_tree: !matches!(mode, ResetMode::Soft),
                },
            )
        }
        DestructiveAction::DeleteBranch { name } => (
            vec!["branch".into(), "-D".into(), name.clone()],
            MutationKind::DeleteBranch,
        ),
        DestructiveAction::DeleteTag { name } => (
            vec!["tag".into(), "-d".into(), name.clone()],
            MutationKind::DeleteTag,
        ),
        DestructiveAction::CheckoutDiscard { branch } => (
            vec!["checkout".into(), "-f".into(), branch.clone()],
            MutationKind::Checkout,
        ),
        DestructiveAction::RecoveryRestore { commit_id } => (
            vec!["reset".into(), "--hard".into(), commit_id.clone()],
            MutationKind::Reset {
                touches_working_tree: true,
            },
        ),
        DestructiveAction::Discard { .. }
        | DestructiveAction::DiscardFiles { .. }
        | DestructiveAction::ForceWithLease
        | DestructiveAction::DeleteRemoteBranch { .. }
        | DestructiveAction::AbortOperation
        | DestructiveAction::DeleteFile { .. }
        | DestructiveAction::StashPop { .. }
        | DestructiveAction::StashDrop { .. } => return Err(GitError::PreflightStale),
    };
    Ok(command)
}
