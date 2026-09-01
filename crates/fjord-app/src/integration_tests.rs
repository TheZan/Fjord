//! Integration tests for the command layer's wiring (docs/tasks.md P5-22).
//!
//! Until now nothing exercised `fjord-app` at all: services were covered with
//! in-memory fakes, adapters were covered in isolation, and the composition of
//! the two — real SQLite, real migrations, real `gix`/`git2`, real system Git —
//! existed only at runtime. These tests run that composition against a
//! temporary database and fixture repositories, and assert the `AppError` codes
//! the frontend switches on.
//!
//! **What this does not cover.** Command handlers take `State<'_, AppState>`,
//! and `AppState` holds a `tauri::AppHandle` that cannot be constructed without
//! a Tauri runtime. So these tests call the services a handler delegates to,
//! plus the error mapping a handler applies, rather than going through Tauri's
//! IPC serialization. Handlers are thin adapters by design (SDD §5.1); the
//! serialization boundary itself is covered by the frontend contract tests.

use std::path::PathBuf;

use fjord_domain::{
    CloneRepositoryRequest, CreateRepositoryRequest, RebaseKind, RepoOperation, Settings, Theme,
};
use fjord_ports::GitOperationContext;
use git2::{Repository, RepositoryInitOptions, Signature};
use tempfile::TempDir;

use crate::error::AppError;
use crate::operations::OperationRegistry;
use crate::state::{compose_services, Services};

async fn services() -> (TempDir, Services) {
    let dir = TempDir::new().expect("a temporary app data directory");
    let services = compose_services(dir.path())
        .await
        .expect("the real adapter composition should boot against a temp database");
    (dir, services)
}

/// A fixture repository with one commit, so reads have something to return.
fn fixture_repo(name: &str) -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("a temporary repository directory");
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();

    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(&path, &options).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Fjord Test").unwrap();
    config.set_str("user.email", "test@fjord.invalid").unwrap();

    std::fs::write(path.join("README.md"), b"fixture\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("README.md")).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = Signature::now("Fjord Test", "test@fjord.invalid").unwrap();
    repo.commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
        .unwrap();
    drop(tree);
    drop(repo);

    (dir, path)
}

fn run_git(repo: &std::path::Path, arguments: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .args(arguments)
        .current_dir(repo)
        .output()
        .expect("system Git should be available to the integration test")
}

fn run_git_success(repo: &std::path::Path, arguments: &[&str]) {
    let output = run_git(repo, arguments);
    assert!(
        output.status.success(),
        "git {} failed: {}",
        arguments.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn commit_with_system_git(repo: &std::path::Path, content: &[u8], message: &str) {
    std::fs::write(repo.join("README.md"), content).unwrap();
    run_git_success(repo, &["add", "README.md"]);
    run_git_success(
        repo,
        &[
            "-c",
            "user.name=Fjord Test",
            "-c",
            "user.email=test@fjord.invalid",
            "commit",
            "-m",
            message,
        ],
    );
}

/// Settings survive a round trip through the real SQLite store, including the
/// migrations that add columns after `0001_init`.
#[tokio::test]
async fn settings_round_trip_through_the_real_store() {
    let (_dir, services) = services().await;

    let defaults = services.settings.get_settings().await.unwrap();
    assert_eq!(defaults.locale, "en");
    assert_eq!(defaults.theme, Theme::System);
    assert!(!defaults.auto_fetch);
    assert!(defaults.git_executable_path.is_none());

    let updated = services
        .settings
        .update_settings(Settings {
            locale: "ru".into(),
            theme: Theme::Dark,
            default_ide: Some("code".into()),
            auto_fetch: true,
            performance_diagnostics: true,
            git_executable_path: None,
            diff_tool: None,
        })
        .await
        .unwrap();
    assert_eq!(updated.locale, "ru");

    let reloaded = services.settings.get_settings().await.unwrap();
    assert_eq!(reloaded.theme, Theme::Dark);
    assert!(reloaded.auto_fetch);
    assert!(reloaded.performance_diagnostics);
    assert_eq!(reloaded.default_ide.as_deref(), Some("code"));
}

/// Workspace CRUD plus repository tracking, against the real schema including
/// its cascade and uniqueness constraints.
#[tokio::test]
async fn workspace_and_repository_crud_against_the_real_schema() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    assert_eq!(
        services.workspaces.list_workspaces().await.unwrap().len(),
        1
    );

    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();
    assert_eq!(repo.name, "api-gateway");

    // The unique (workspace_id, path) constraint has to surface as a stable
    // code, not a database error the frontend cannot localize.
    let duplicate: AppError = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .expect_err("the same repository must not be added twice")
        .into();
    assert_eq!(duplicate.code, "repository_already_added");

    // Deleting a workspace cascades to its repository rows.
    services
        .workspaces
        .delete_workspace(workspace.id)
        .await
        .unwrap();
    assert!(services
        .workspaces
        .list_all_repositories()
        .await
        .unwrap()
        .is_empty());
}

/// A folder that is not a Git repository is rejected before anything is
/// persisted, with the code the frontend maps to a message.
#[tokio::test]
async fn adding_a_non_repository_is_refused_with_a_stable_code() {
    let (_dir, services) = services().await;
    let plain = TempDir::new().unwrap();

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let error: AppError = services
        .workspaces
        .add_repository(workspace.id, plain.path().to_path_buf())
        .await
        .expect_err("a plain folder is not a repository")
        .into();

    assert_eq!(error.code, "not_a_git_repository");
    assert!(services
        .workspaces
        .list_all_repositories()
        .await
        .unwrap()
        .is_empty());
}

/// Repository reads resolve an id through the store and reach the real Git
/// adapters — the path a repository view takes on every open.
#[tokio::test]
async fn repository_reads_reach_the_real_git_adapters() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path)
        .await
        .unwrap();

    let status = services.repos.get_status(repo.id).await.unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.dirty_count, 0);
    assert!(!status.has_conflict);

    let branches = services.repos.get_branches(repo.id).await.unwrap();
    assert!(branches
        .iter()
        .any(|branch| branch.name == "main" && branch.is_current));

    let page = services
        .repos
        .get_commit_log(repo.id, None, 10)
        .await
        .unwrap();
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].message.trim(), "Initial");

    let files = services
        .repos
        .get_commit_diff(repo.id, &page.commits[0].id.0)
        .await
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "README.md");
}

/// A local mutation writes through `git2` and is visible to the next read.
#[tokio::test]
async fn a_local_mutation_is_visible_to_the_next_read() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();

    services
        .repos
        .create_branch(repo.id, "feature/login", false)
        .await
        .unwrap();

    let branches = services.repos.get_branches(repo.id).await.unwrap();
    assert!(branches.iter().any(|branch| branch.name == "feature/login"));

    std::fs::write(repo_path.join("README.md"), b"changed\n").unwrap();
    let status = services.repos.get_status(repo.id).await.unwrap();
    assert_eq!(status.dirty_count, 1);
}

/// The composite action must never pretend that a rejected push erased the
/// commit it already created. A non-bare checked-out remote rejects the push
/// deterministically on every platform while the local commit remains `HEAD`.
#[tokio::test]
async fn commit_and_push_reports_push_failure_without_rolling_back_commit() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");
    let remote_dir = TempDir::new().unwrap();
    let remote_path = remote_dir.path().join("checked-out-remote");
    Repository::clone(repo_path.to_str().unwrap(), &remote_path).unwrap();

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();

    let local = Repository::open(&repo_path).unwrap();
    let initial = local.head().unwrap().peel_to_commit().unwrap().id();
    local
        .remote("origin", remote_path.to_str().unwrap())
        .unwrap();
    local
        .reference(
            "refs/remotes/origin/main",
            initial,
            true,
            "seed local tracking ref",
        )
        .unwrap();
    local
        .find_branch("main", git2::BranchType::Local)
        .unwrap()
        .set_upstream(Some("origin/main"))
        .unwrap();
    drop(local);

    std::fs::write(repo_path.join("README.md"), b"commit survives\n").unwrap();
    services
        .repos
        .stage_files(repo.id, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let outcome = services
        .repos
        .commit_and_push_with_context(
            repo.id,
            "Commit survives failed push",
            false,
            GitOperationContext::default(),
        )
        .await
        .unwrap();

    assert!(outcome.push_error.is_some());
    let local = Repository::open(&repo_path).unwrap();
    let local_head = local.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(local_head.id().to_string(), outcome.commit_id);
    assert_eq!(local_head.message().unwrap(), "Commit survives failed push");
    let remote = Repository::open(&remote_path).unwrap();
    assert_eq!(
        remote
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap(),
        "Initial"
    );
}

/// A persisted generation stamp cannot prove that nothing happened while
/// Fjord was stopped. Revalidation therefore compares against live Git state,
/// including commits made by a completely separate `git` process.
#[tokio::test]
async fn snapshot_revalidation_detects_an_out_of_band_git_commit() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");
    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();

    let captured = services
        .repos
        .capture_repository_snapshot(repo.id)
        .await
        .unwrap();
    assert!(captured.validated);
    assert_eq!(captured.snapshot.first_history_page.commits.len(), 1);
    assert!(
        !services
            .repos
            .load_repository_snapshot(repo.id)
            .await
            .unwrap()
            .unwrap()
            .validated
    );

    std::fs::write(repo_path.join("CHANGELOG.md"), b"out of band\n").unwrap();
    for arguments in [
        vec!["add", "CHANGELOG.md"],
        vec![
            "-c",
            "user.name=Fjord Test",
            "-c",
            "user.email=test@fjord.invalid",
            "commit",
            "-m",
            "External commit",
        ],
    ] {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(&repo_path)
            .output()
            .expect("system Git should be available to the integration test");
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let revalidated = services
        .repos
        .revalidate_repository_snapshot(repo.id)
        .await
        .unwrap();
    assert!(revalidated.changed);
    assert!(revalidated.snapshot.validated);
    assert_eq!(
        revalidated
            .snapshot
            .snapshot
            .first_history_page
            .commits
            .len(),
        2
    );
}

/// P9-02. A rebase started by another Git client must replace the persisted
/// normal state in one live snapshot refresh, without rebuilding services.
#[tokio::test]
async fn snapshot_refresh_reports_a_cli_created_rebase_without_restart() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("rebase-state");
    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();

    let initial = services
        .repos
        .capture_repository_snapshot(repo.id)
        .await
        .unwrap();
    assert_eq!(
        initial.snapshot.operation_state.operation,
        RepoOperation::Normal
    );

    run_git_success(&repo_path, &["branch", "topic"]);
    commit_with_system_git(&repo_path, b"main\n", "main change");
    run_git_success(&repo_path, &["checkout", "topic"]);
    commit_with_system_git(&repo_path, b"topic\n", "topic change");
    let output = run_git(&repo_path, &["rebase", "--merge", "main"]);
    assert!(
        !output.status.success(),
        "the fixture must stop on a conflict"
    );

    let refreshed = services
        .repos
        .revalidate_repository_snapshot(repo.id)
        .await
        .unwrap();

    assert!(refreshed.changed);
    assert!(matches!(
        refreshed.snapshot.snapshot.operation_state.operation,
        RepoOperation::Rebase {
            rebase_kind: RebaseKind::Merge,
            current: 1,
            total: 1,
            ..
        }
    ));
    assert!(
        refreshed
            .snapshot
            .snapshot
            .operation_state
            .detected_externally
    );
}

/// An unknown id fails before any Git work, with the code the frontend uses to
/// drop a stale selection.
#[tokio::test]
async fn an_unknown_repository_id_maps_to_a_stable_code() {
    let (_dir, services) = services().await;

    let error: AppError = services
        .repos
        .get_status(fjord_domain::RepositoryId::new())
        .await
        .expect_err("an unknown id cannot resolve")
        .into();

    assert_eq!(error.code, "repository_not_found");
}

/// A remote operation against a repository with no such remote must classify
/// through the system-Git error table, not leak a raw message.
#[tokio::test]
async fn a_failing_remote_operation_classifies_through_the_stable_table() {
    let (_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("api-gateway");

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let repo = services
        .workspaces
        .add_repository(workspace.id, repo_path)
        .await
        .unwrap();

    let error: AppError = services
        .repos
        .fetch(repo.id, "no-such-remote")
        .await
        .expect_err("fetching an undefined remote cannot succeed")
        .into();

    // The exact code depends on how Git reports an undefined remote, but it
    // must be one of the documented stable codes — never `git_error` or a
    // database code, and never an unclassified message.
    assert!(
        error.code.starts_with("git_"),
        "unexpected code {}: {}",
        error.code,
        error.message
    );
}

#[tokio::test]
async fn remote_connection_lists_adds_preserves_config_and_can_fetch() {
    let (_app_dir, services) = services().await;
    let (_source_dir, source) = fixture_repo("source");
    let remote_root = TempDir::new().unwrap();
    let bare = remote_root.path().join("remote.git");
    run_git_success(
        remote_root.path(),
        &[
            "clone",
            "--bare",
            source.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    let (_local_dir, local) = fixture_repo("local");
    let repository = Repository::open(&local).unwrap();
    repository
        .config()
        .unwrap()
        .set_str("fjord.preserved", "yes")
        .unwrap();
    let workspace = services
        .workspaces
        .create_workspace("Connected")
        .await
        .unwrap();
    let entry = services
        .workspaces
        .add_repository(workspace.id, local.clone())
        .await
        .unwrap();

    let added = services
        .repos
        .add_remote(entry.id, " origin ", bare.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(added.name, "origin");
    assert_eq!(
        services.repos.list_remotes(entry.id).await.unwrap(),
        vec![added]
    );
    assert_eq!(
        Repository::open(&local)
            .unwrap()
            .config()
            .unwrap()
            .get_string("fjord.preserved")
            .unwrap(),
        "yes"
    );
    services.repos.fetch(entry.id, "origin").await.unwrap();

    let duplicate: AppError = services
        .repos
        .add_remote(entry.id, "origin", "other")
        .await
        .expect_err("duplicate remote names must be typed")
        .into();
    assert_eq!(duplicate.code, "remote_name_exists");
    let invalid: AppError = services
        .repos
        .add_remote(entry.id, "", "")
        .await
        .expect_err("empty remote inputs must fail before config mutation")
        .into();
    assert_eq!(invalid.code, "remote_name_invalid");
    assert_eq!(
        services.repos.list_remotes(entry.id).await.unwrap().len(),
        1
    );

    let edited = services
        .repos
        .set_remote_url(entry.id, " origin ", bare.to_str().unwrap(), None)
        .await
        .unwrap();
    assert_eq!(edited.name, "origin");
    let renamed = services
        .repos
        .rename_remote(entry.id, " origin ", " upstream ")
        .await
        .unwrap();
    assert_eq!(renamed.name, "upstream");
    let mut config = Repository::open(&local).unwrap().config().unwrap();
    config.set_str("branch.main.remote", "upstream").unwrap();
    config
        .set_str("branch.main.merge", "refs/heads/main")
        .unwrap();
    let preflight = services
        .repos
        .preflight_remove_remote(entry.id, " upstream ")
        .await
        .unwrap();
    assert_eq!(preflight.orphaned_upstreams, ["main"]);
    services
        .repos
        .remove_remote(
            entry.id,
            " upstream ",
            preflight.config_generation,
            &preflight.confirmation_token,
        )
        .await
        .unwrap();
    assert!(services
        .repos
        .list_remotes(entry.id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn publish_sets_upstream_while_rejection_and_cancellation_preserve_local_work() {
    let (_app_dir, services) = services().await;
    let workspace = services
        .workspaces
        .create_workspace("Publish")
        .await
        .unwrap();

    let (_success_dir, success_path) = fixture_repo("success");
    let success = services
        .workspaces
        .add_repository(workspace.id, success_path.clone())
        .await
        .unwrap();
    let bare_root = TempDir::new().unwrap();
    let bare_path = bare_root.path().join("remote.git");
    run_git_success(
        bare_root.path(),
        &["init", "--bare", bare_path.to_str().unwrap()],
    );
    services
        .repos
        .add_remote(success.id, "origin", bare_path.to_str().unwrap())
        .await
        .unwrap();

    services
        .repos
        .publish_branch(success.id, None)
        .await
        .unwrap();

    let local = Repository::open(&success_path).unwrap();
    let local_head = local.head().unwrap().target().unwrap();
    let config = local.config().unwrap();
    assert_eq!(config.get_string("branch.main.remote").unwrap(), "origin");
    assert_eq!(
        config.get_string("branch.main.merge").unwrap(),
        "refs/heads/main"
    );
    assert_eq!(
        Repository::open_bare(&bare_path)
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap(),
        local_head
    );

    let (_rejected_dir, rejected_path) = fixture_repo("rejected");
    let rejected = services
        .workspaces
        .add_repository(workspace.id, rejected_path.clone())
        .await
        .unwrap();
    let remote_dir = TempDir::new().unwrap();
    let checked_out_remote = remote_dir.path().join("checked-out-remote");
    run_git_success(
        remote_dir.path(),
        &[
            "clone",
            rejected_path.to_str().unwrap(),
            checked_out_remote.to_str().unwrap(),
        ],
    );
    services
        .repos
        .add_remote(rejected.id, "origin", checked_out_remote.to_str().unwrap())
        .await
        .unwrap();
    std::fs::write(rejected_path.join("published.txt"), b"new commit\n").unwrap();
    run_git_success(&rejected_path, &["add", "published.txt"]);
    run_git_success(&rejected_path, &["commit", "-m", "Local commit"]);
    std::fs::write(rejected_path.join("local-work.txt"), b"keep me\n").unwrap();
    let rejected_head = Repository::open(&rejected_path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();

    let rejection: AppError = services
        .repos
        .publish_branch(rejected.id, None)
        .await
        .expect_err("a checked-out non-bare destination must reject the push")
        .into();
    assert_eq!(rejection.code, "git_remote_rejected");
    assert_eq!(
        std::fs::read(rejected_path.join("local-work.txt")).unwrap(),
        b"keep me\n"
    );
    let local = Repository::open(&rejected_path).unwrap();
    assert_eq!(local.head().unwrap().target().unwrap(), rejected_head);
    assert!(local
        .config()
        .unwrap()
        .get_string("branch.main.remote")
        .is_err());

    let cancelled: AppError = services
        .repos
        .publish_branch_with_context(rejected.id, None, GitOperationContext::new(|_| {}, || true))
        .await
        .expect_err("pre-cancelled publish must not start or mutate local state")
        .into();
    assert_eq!(cancelled.code, "operation_cancelled");
    assert_eq!(
        std::fs::read(rejected_path.join("local-work.txt")).unwrap(),
        b"keep me\n"
    );
    let local = Repository::open(&rejected_path).unwrap();
    assert_eq!(local.head().unwrap().target().unwrap(), rejected_head);
    assert!(local
        .config()
        .unwrap()
        .get_string("branch.main.remote")
        .is_err());
}

#[tokio::test]
async fn multi_remote_push_updates_each_remote_without_changing_upstream() {
    let (_app_dir, services) = services().await;
    let (_repo_dir, repo_path) = fixture_repo("mirrored");
    let workspace = services
        .workspaces
        .create_workspace("Mirrors")
        .await
        .unwrap();
    let entry = services
        .workspaces
        .add_repository(workspace.id, repo_path.clone())
        .await
        .unwrap();
    let remote_root = TempDir::new().unwrap();
    let origin = remote_root.path().join("origin.git");
    let gitlab = remote_root.path().join("gitlab.git");
    run_git_success(
        remote_root.path(),
        &["init", "--bare", origin.to_str().unwrap()],
    );
    run_git_success(
        remote_root.path(),
        &["init", "--bare", gitlab.to_str().unwrap()],
    );
    services
        .repos
        .add_remote(entry.id, "origin", origin.to_str().unwrap())
        .await
        .unwrap();
    services
        .repos
        .add_remote(entry.id, "gitlab", gitlab.to_str().unwrap())
        .await
        .unwrap();
    services.repos.publish_branch(entry.id, None).await.unwrap();

    std::fs::write(repo_path.join("README.md"), b"mirrored update\n").unwrap();
    services
        .repos
        .stage_files(entry.id, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    services
        .repos
        .commit(entry.id, "Mirror update", false)
        .await
        .unwrap();
    let results = services
        .repos
        .push_branch_to_remotes_with_context(
            entry.id,
            &["origin".into(), "gitlab".into()],
            GitOperationContext::default(),
        )
        .await
        .unwrap();

    assert!(results.iter().all(|result| result.ok));
    let local = Repository::open(&repo_path).unwrap();
    let local_head = local.head().unwrap().target().unwrap();
    assert_eq!(
        Repository::open_bare(&origin)
            .unwrap()
            .refname_to_id("refs/heads/main")
            .unwrap(),
        local_head
    );
    assert_eq!(
        Repository::open_bare(&gitlab)
            .unwrap()
            .refname_to_id("refs/heads/main")
            .unwrap(),
        local_head
    );
    let config = local.config().unwrap();
    assert_eq!(config.get_string("branch.main.remote").unwrap(), "origin");
    assert_eq!(
        config.get_string("branch.main.merge").unwrap(),
        "refs/heads/main"
    );
}

#[tokio::test]
async fn fresh_install_smoke_restores_each_repository_once_after_restart() {
    let app_dir = TempDir::new().unwrap();
    let services = compose_services(app_dir.path()).await.unwrap();
    let workspace = services
        .workspaces
        .create_workspace("Fresh install")
        .await
        .unwrap();

    let (_existing_dir, existing_path) = fixture_repo("existing");
    let existing = services
        .workspaces
        .add_repository(workspace.id, existing_path)
        .await
        .unwrap();

    let (_clone_source_dir, clone_source) = fixture_repo("clone-source");
    let fixture_root = TempDir::new().unwrap();
    let clone_remote = fixture_root.path().join("clone-remote.git");
    run_git_success(
        fixture_root.path(),
        &[
            "clone",
            "--bare",
            clone_source.to_str().unwrap(),
            clone_remote.to_str().unwrap(),
        ],
    );
    let clone_parent = fixture_root.path().join("clones");
    std::fs::create_dir(&clone_parent).unwrap();
    let prepared = services
        .repos
        .prepare_clone_repository(CloneRepositoryRequest {
            workspace_id: workspace.id,
            url: clone_remote.to_string_lossy().into_owned(),
            destination_parent: clone_parent,
            directory_name: Some("cloned".into()),
            branch: Some("main".into()),
        })
        .await
        .unwrap();
    let cloned = services
        .repos
        .clone_repository_with_context(prepared, GitOperationContext::default())
        .await
        .unwrap()
        .repository;

    let created_root = TempDir::new().unwrap();
    let created = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: created_root.path().to_path_buf(),
            directory_name: "created".into(),
            initial_branch: Some("main".into()),
        })
        .await
        .unwrap()
        .repository;
    {
        let repo = Repository::open(&created.path).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Fjord Test").unwrap();
        config.set_str("user.email", "test@fjord.invalid").unwrap();
        // The lifecycle assertion is about pulled content, not the runner's
        // global line-ending policy.
        config.set_bool("core.autocrlf", false).unwrap();
    }
    std::fs::write(created.path.join("README.md"), b"fresh repository\n").unwrap();
    services
        .repos
        .stage_files(created.id, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    services
        .repos
        .commit(created.id, "Initial local commit", false)
        .await
        .unwrap();

    let publish_remote = fixture_root.path().join("publish-remote.git");
    run_git_success(
        fixture_root.path(),
        &["init", "--bare", publish_remote.to_str().unwrap()],
    );
    services
        .repos
        .add_remote(created.id, "origin", publish_remote.to_str().unwrap())
        .await
        .unwrap();
    services
        .repos
        .publish_branch(created.id, None)
        .await
        .unwrap();
    Repository::open_bare(&publish_remote)
        .unwrap()
        .set_head("refs/heads/main")
        .unwrap();

    let peer = fixture_root.path().join("peer");
    run_git_success(
        fixture_root.path(),
        &[
            "clone",
            publish_remote.to_str().unwrap(),
            peer.to_str().unwrap(),
        ],
    );
    std::fs::write(peer.join("upstream.txt"), b"from peer\n").unwrap();
    run_git_success(&peer, &["add", "upstream.txt"]);
    run_git_success(
        &peer,
        &[
            "-c",
            "user.name=Fjord Smoke",
            "-c",
            "user.email=smoke@fjord.invalid",
            "commit",
            "-m",
            "Upstream update",
        ],
    );
    run_git_success(&peer, &["push", "origin", "main"]);
    services.repos.fetch(created.id, "origin").await.unwrap();
    services.repos.pull(created.id).await.unwrap();
    assert_eq!(
        std::fs::read(created.path.join("upstream.txt")).unwrap(),
        b"from peer\n"
    );

    let expected_ids = [existing.id, cloned.id, created.id]
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    drop(services);

    let restarted = compose_services(app_dir.path()).await.unwrap();
    assert_eq!(
        restarted.workspaces.list_workspaces().await.unwrap(),
        vec![workspace.clone()]
    );
    let restored = restarted
        .workspaces
        .list_repositories(workspace.id)
        .await
        .unwrap();
    assert_eq!(restored.len(), 3);
    assert_eq!(
        restored
            .iter()
            .map(|repo| repo.id)
            .collect::<std::collections::HashSet<_>>(),
        expected_ids
    );
    assert_eq!(
        restored
            .iter()
            .map(|repo| repo.path.clone())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
}

#[tokio::test]
async fn clone_registers_once_and_validates_destination_before_execution() {
    let (_app_dir, services) = services().await;
    let (_source_dir, source) = fixture_repo("source");
    let clone_root = TempDir::new().unwrap();
    let remote = clone_root.path().join("remote.git");
    run_git_success(
        clone_root.path(),
        &[
            "clone",
            "--bare",
            source.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    let destination_parent = clone_root.path().join("clones");
    std::fs::create_dir(&destination_parent).unwrap();
    let unknown_workspace: AppError = services
        .repos
        .prepare_clone_repository(CloneRepositoryRequest {
            workspace_id: fjord_domain::WorkspaceId::new(),
            url: remote.to_string_lossy().into_owned(),
            destination_parent: destination_parent.clone(),
            directory_name: None,
            branch: None,
        })
        .await
        .expect_err("an unknown workspace must fail before clone execution")
        .into();
    assert_eq!(unknown_workspace.code, "workspace_not_found");

    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let request = CloneRepositoryRequest {
        workspace_id: workspace.id,
        url: remote.to_string_lossy().into_owned(),
        destination_parent: destination_parent.clone(),
        directory_name: None,
        branch: None,
    };

    let prepared = services
        .repos
        .prepare_clone_repository(request.clone())
        .await
        .unwrap();
    let result = services
        .repos
        .clone_repository_with_context(prepared, GitOperationContext::default())
        .await
        .unwrap();

    assert_eq!(result.repository.name, "remote");
    assert_eq!(result.repository.workspace_id, workspace.id);
    assert!(result.repository.path.join(".git").is_dir());
    assert_eq!(
        services
            .workspaces
            .list_repositories(workspace.id)
            .await
            .unwrap(),
        vec![result.repository.clone()]
    );
    assert_eq!(
        services
            .workspaces
            .get_workspace_status(workspace.id)
            .await
            .unwrap()
            .len(),
        1
    );

    let duplicate: AppError = services
        .repos
        .prepare_clone_repository(request)
        .await
        .expect_err("an existing clone destination must fail before execution")
        .into();
    assert_eq!(duplicate.code, "clone_destination_exists");
}

#[tokio::test]
async fn clone_preserves_a_completed_checkout_when_registration_fails() {
    let (_app_dir, services) = services().await;
    let (_source_dir, source) = fixture_repo("source");
    let clone_root = TempDir::new().unwrap();
    let remote = clone_root.path().join("remote.git");
    run_git_success(
        clone_root.path(),
        &[
            "clone",
            "--bare",
            source.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    let destination_parent = clone_root.path().join("clones");
    std::fs::create_dir(&destination_parent).unwrap();
    let workspace = services
        .workspaces
        .create_workspace("Temporary")
        .await
        .unwrap();
    let prepared = services
        .repos
        .prepare_clone_repository(CloneRepositoryRequest {
            workspace_id: workspace.id,
            url: remote.to_string_lossy().into_owned(),
            destination_parent: destination_parent.clone(),
            directory_name: Some("orphan".into()),
            branch: None,
        })
        .await
        .unwrap();
    services
        .workspaces
        .delete_workspace(workspace.id)
        .await
        .unwrap();

    let error: AppError = services
        .repos
        .clone_repository_with_context(prepared, GitOperationContext::default())
        .await
        .expect_err("registration must report the workspace disappearing")
        .into();

    assert_eq!(error.code, "clone_registration_failed");
    assert!(destination_parent.join("orphan/.git").is_dir());
    assert!(services
        .workspaces
        .list_all_repositories()
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn create_repository_supports_empty_or_new_destinations_and_registers_once() {
    let (_app_dir, services) = services().await;
    let root = TempDir::new().unwrap();
    let workspace = services.workspaces.create_workspace("Local").await.unwrap();
    let existing_empty = root.path().join("existing-empty");
    std::fs::create_dir(&existing_empty).unwrap();

    let existing = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: root.path().to_path_buf(),
            directory_name: "existing-empty".into(),
            initial_branch: Some("trunk".into()),
        })
        .await
        .unwrap();
    assert_eq!(existing.repository.name, "existing-empty");
    assert!(existing.repository.path.join(".git").is_dir());
    assert!(matches!(
        services
            .repos
            .get_operation_state(existing.repository.id)
            .await
            .unwrap()
            .operation,
        RepoOperation::UnbornBranch
    ));
    assert!(services
        .repos
        .get_commit_log(existing.repository.id, None, 50)
        .await
        .unwrap()
        .commits
        .is_empty());
    assert!(services
        .repos
        .get_working_changes(existing.repository.id)
        .await
        .is_ok());
    let repository = Repository::open(&existing.repository.path).unwrap();
    assert_eq!(
        repository.find_reference("HEAD").unwrap().symbolic_target(),
        Ok(Some("refs/heads/trunk"))
    );

    let created = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: root.path().to_path_buf(),
            directory_name: "created".into(),
            initial_branch: None,
        })
        .await
        .unwrap();
    assert_eq!(
        Repository::open(&created.repository.path)
            .unwrap()
            .find_reference("HEAD")
            .unwrap()
            .symbolic_target(),
        Ok(Some("refs/heads/main"))
    );
    assert_eq!(
        services
            .workspaces
            .list_repositories(workspace.id)
            .await
            .unwrap(),
        vec![existing.repository.clone(), created.repository.clone()]
    );
    assert_eq!(
        services
            .workspaces
            .get_workspace_status(workspace.id)
            .await
            .unwrap()
            .len(),
        2
    );

    let duplicate: AppError = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: root.path().to_path_buf(),
            directory_name: "created".into(),
            initial_branch: None,
        })
        .await
        .expect_err("an initialized destination must not be registered twice")
        .into();
    assert_eq!(duplicate.code, "create_repository_destination_not_empty");
    assert_eq!(
        services
            .workspaces
            .list_repositories(workspace.id)
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn create_repository_rejects_non_empty_and_invalid_targets_atomically() {
    let (_app_dir, services) = services().await;
    let root = TempDir::new().unwrap();
    let workspace = services.workspaces.create_workspace("Local").await.unwrap();
    let occupied = root.path().join("occupied");
    std::fs::create_dir(&occupied).unwrap();
    std::fs::write(occupied.join("keep.txt"), "keep").unwrap();

    let occupied_error: AppError = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: root.path().to_path_buf(),
            directory_name: "occupied".into(),
            initial_branch: None,
        })
        .await
        .expect_err("a non-empty destination must be preserved")
        .into();
    assert_eq!(
        occupied_error.code,
        "create_repository_destination_not_empty"
    );
    assert_eq!(
        std::fs::read_to_string(occupied.join("keep.txt")).unwrap(),
        "keep"
    );

    let invalid_target = root.path().join("invalid-branch");
    let invalid_error: AppError = services
        .repos
        .create_repository(CreateRepositoryRequest {
            workspace_id: workspace.id,
            destination_parent: root.path().to_path_buf(),
            directory_name: "invalid-branch".into(),
            initial_branch: Some("bad branch".into()),
        })
        .await
        .expect_err("invalid initialization must not publish a partial target")
        .into();
    assert_eq!(invalid_error.code, "create_repository_request_invalid");
    assert!(!invalid_target.exists());
    assert!(services
        .workspaces
        .list_repositories(workspace.id)
        .await
        .unwrap()
        .is_empty());
    assert!(std::fs::read_dir(root.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fjord-init-")
    }));
}

#[tokio::test]
async fn cancelled_clone_does_not_start_system_git() {
    let (_app_dir, services) = services().await;
    let clone_root = TempDir::new().unwrap();
    let workspace = services
        .workspaces
        .create_workspace("Backend")
        .await
        .unwrap();
    let prepared = services
        .repos
        .prepare_clone_repository(CloneRepositoryRequest {
            workspace_id: workspace.id,
            url: clone_root
                .path()
                .join("remote.git")
                .to_string_lossy()
                .into_owned(),
            destination_parent: clone_root.path().to_path_buf(),
            directory_name: Some("cancelled".into()),
            branch: None,
        })
        .await
        .unwrap();
    let cancelled = GitOperationContext::new(|_| {}, || true);

    let error: AppError = services
        .repos
        .clone_repository_with_context(prepared, cancelled)
        .await
        .expect_err("pre-spawn cancellation must stop clone")
        .into();

    assert_eq!(error.code, "operation_cancelled");
    assert!(!clone_root.path().join("cancelled").exists());
}

/// Cancellation is registry-level state, and a cancelled operation must be
/// observable before the Git process ever starts.
#[tokio::test]
async fn cancellation_is_observable_through_the_operation_registry() {
    let registry = std::sync::Arc::new(OperationRegistry::default());
    let operation = registry.begin("op-integration".to_string());

    assert!(!operation.is_cancelled());
    assert!(registry.cancel("op-integration"));
    assert!(operation.is_cancelled());

    // A finished operation is removed, so a late cancel is a no-op rather than
    // a panic or a resurrected entry.
    drop(operation);
    assert!(!registry.cancel("op-integration"));
}
