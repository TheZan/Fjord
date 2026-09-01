use std::io::Write;
use std::sync::Arc;

use super::destructive_confirmation::DestructiveConfirmationStore;
use super::*;
use crate::remote::errors::sanitize_diagnostics;
use fjord_domain::RemoveRemotePreflight;

pub(super) async fn list(repo: &RepoPath) -> Result<Vec<RemoteInfo>, GitError> {
    let repo = repo.clone();
    let _guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut names = git
                .remotes()
                .map_err(LocalGitBackend::map_git2_error)?
                .iter()
                .map(|name| name.map_err(LocalGitBackend::map_git2_error))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            names.sort();
            names
                .into_iter()
                .map(|name| remote_info(git, &name))
                .collect()
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn add(repo: &RepoPath, name: &str, url: &str) -> Result<RemoteInfo, GitError> {
    validate_name(name)?;
    validate_url(url)?;

    let repo = repo.clone();
    let name = name.to_string();
    let url = url.to_string();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let remote = tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || {
            LocalGitBackend::with_runtime_git2(&repo, |git| {
                if git.find_remote(&name).is_ok() {
                    return Err(GitError::RemoteAlreadyExists(name));
                }
                git.remote(&name, &url)
                    .map_err(|error| match error.code() {
                        ErrorCode::Exists => GitError::RemoteAlreadyExists(name.clone()),
                        _ => GitError::InvalidRemoteUrl,
                    })?;
                remote_info(git, &name)
            })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    runtime::bump_mutation(&repo, MutationKind::AddRemote);
    Ok(remote)
}

pub(super) async fn set_url(
    repo: &RepoPath,
    name: &str,
    fetch: &str,
    push: Option<&str>,
) -> Result<RemoteInfo, GitError> {
    set_url_with_committer(repo, name, fetch, push, AtomicConfigCommitter).await
}

async fn set_url_with_committer<C: ConfigCommitter>(
    repo: &RepoPath,
    name: &str,
    fetch: &str,
    push: Option<&str>,
    committer: C,
) -> Result<RemoteInfo, GitError> {
    validate_name(name)?;
    validate_url(fetch)?;
    if let Some(push) = push {
        validate_url(push)?;
    }

    let repo = repo.clone();
    let name = name.to_string();
    let fetch = fetch.to_string();
    let push = push.map(ToString::to_string);
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let remote = tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || {
            LocalGitBackend::with_runtime_git2(&repo, |git| {
                ensure_remote_exists(git, &name)?;
                let fetch_url_count = remote_value_count(git, &name, "url")?;
                let push_url_count = remote_value_count(git, &name, "pushurl")?;
                // libgit2's single-value setters reject multi-valued URL keys.
                // Inspect both keys before either setter writes so an unsupported
                // remote fails without partially changing its fetch URL.
                if fetch_url_count > 1 || push_url_count > 1 {
                    return Err(GitError::InvalidRemoteUrl);
                }
                write_remote_urls_transaction(
                    git,
                    &name,
                    &fetch,
                    push.as_deref(),
                    push_url_count,
                    committer,
                )
            })?;

            // No fallible work follows config publication: returning Err after
            // the atomic replace would violate the mutation/generation contract.
            Ok(RemoteInfo {
                name,
                fetch_url: sanitize_diagnostics(&fetch),
                push_url: push.as_deref().map(sanitize_diagnostics),
            })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    runtime::bump_mutation(&repo, MutationKind::SetRemoteUrl);
    Ok(remote)
}

trait ConfigCommitter: Send + 'static {
    fn commit(self, marker: gix_lock::Marker) -> Result<(), GitError>;
}

struct AtomicConfigCommitter;

impl ConfigCommitter for AtomicConfigCommitter {
    fn commit(self, marker: gix_lock::Marker) -> Result<(), GitError> {
        marker
            .commit()
            .map(|_| ())
            .map_err(|_| GitError::InvalidRemoteUrl)
    }
}

fn write_remote_urls_transaction<C: ConfigCommitter>(
    git: &git2::Repository,
    name: &str,
    fetch: &str,
    push: Option<&str>,
    push_url_count: usize,
    committer: C,
) -> Result<(), GitError> {
    let config_path = git.commondir().join("config");
    let mut lock = gix_lock::File::acquire_to_update_resource(
        &config_path,
        gix_lock::acquire::Fail::Immediately,
        None,
    )
    .map_err(|_| GitError::InvalidRemoteUrl)?;

    // Read only after acquiring Git's standard config lock. Both edits are
    // prepared in the lock file, and the original is replaced only once every
    // fallible config operation has succeeded.
    {
        let mut original =
            std::fs::File::open(&config_path).map_err(|_| GitError::InvalidRemoteUrl)?;
        std::io::copy(&mut original, &mut lock).map_err(|_| GitError::InvalidRemoteUrl)?;
    }
    lock.flush().map_err(|_| GitError::InvalidRemoteUrl)?;
    let marker = lock.close().map_err(|_| GitError::InvalidRemoteUrl)?;

    {
        let mut staged =
            git2::Config::open(marker.lock_path()).map_err(|_| GitError::InvalidRemoteUrl)?;
        staged
            .set_str(&format!("remote.{name}.url"), fetch)
            .map_err(|_| GitError::InvalidRemoteUrl)?;
        match push {
            Some(push) => staged
                .set_str(&format!("remote.{name}.pushurl"), push)
                .map_err(|_| GitError::InvalidRemoteUrl)?,
            None if push_url_count == 1 => staged
                .remove(&format!("remote.{name}.pushurl"))
                .map_err(|_| GitError::InvalidRemoteUrl)?,
            None => {}
        }
    }

    committer.commit(marker)
}

pub(super) async fn rename(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    old: &str,
    new: &str,
) -> Result<RemoteInfo, GitError> {
    validate_name(old)?;
    validate_name(new)?;

    let repo = repo.clone();
    let old = old.to_string();
    let new = new.to_string();
    let commands = commands.clone();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    let existing = tokio::task::spawn_blocking({
        let repo = repo.clone();
        let old = old.clone();
        let new = new.clone();
        move || {
            LocalGitBackend::with_runtime_git2(&repo, |git| {
                ensure_remote_exists(git, &old)?;
                if old == new {
                    return remote_info(git, &old).map(Some);
                }
                if git.find_remote(&new).is_ok() {
                    return Err(GitError::RemoteRenameTargetExists(new));
                }
                Ok(None)
            })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    if let Some(remote) = existing {
        return Ok(remote);
    }

    let remote = tokio::task::spawn_blocking({
        let repo = repo.clone();
        let new_name = new.clone();
        move || {
            LocalGitBackend::run_local_git(&commands, &repo, &["remote", "rename", &old, &new])?;
            LocalGitBackend::with_runtime_git2(&repo, |git| remote_info(git, &new_name))
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    runtime::bump_mutation(&repo, MutationKind::RenameRemote);
    Ok(remote)
}

pub(super) async fn preflight_remove(
    repo: &RepoPath,
    name: &str,
    confirmations: Arc<DestructiveConfirmationStore>,
) -> Result<RemoveRemotePreflight, GitError> {
    validate_name(name)?;

    let repo = repo.clone();
    let name = name.to_string();
    let _guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    let before = runtime::generations(&repo)?.config;
    let orphaned_upstreams = tokio::task::spawn_blocking({
        let repo = repo.clone();
        let name = name.clone();
        move || {
            LocalGitBackend::with_runtime_git2(&repo, |git| {
                ensure_remote_exists(git, &name)?;
                configured_upstream_branches(git, &name)
            })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    let config_generation = runtime::generations(&repo)?.config;
    if before != config_generation {
        return Err(GitError::PreflightStale);
    }
    let confirmation_token =
        confirmations.issue_remote_removal(&repo, &name, &orphaned_upstreams, config_generation)?;
    Ok(RemoveRemotePreflight {
        remote: name,
        orphaned_upstreams,
        config_generation,
        confirmation_token,
    })
}

pub(super) async fn remove(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    expected_config_generation: u64,
    confirmation_token: &str,
    confirmations: Arc<DestructiveConfirmationStore>,
) -> Result<(), GitError> {
    validate_name(name)?;

    let repo = repo.clone();
    let name = name.to_string();
    let confirmation_token = confirmation_token.to_string();
    let commands = commands.clone();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    if runtime::generations(&repo)?.config != expected_config_generation {
        return Err(GitError::PreflightStale);
    }

    let orphaned_upstreams = tokio::task::spawn_blocking({
        let repo = repo.clone();
        let name = name.clone();
        move || {
            LocalGitBackend::with_runtime_git2(&repo, |git| {
                ensure_remote_exists(git, &name)?;
                configured_upstream_branches(git, &name)
            })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    confirmations.consume_remote_removal(
        &confirmation_token,
        &repo,
        &name,
        &orphaned_upstreams,
        expected_config_generation,
    )?;

    tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || LocalGitBackend::run_local_git(&commands, &repo, &["remote", "remove", &name])
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))??;
    runtime::bump_mutation(&repo, MutationKind::RemoveRemote);
    Ok(())
}

fn validate_name(name: &str) -> Result<(), GitError> {
    if name.trim().is_empty() || name.contains('\0') || !git2::Remote::is_valid_name(name) {
        return Err(GitError::InvalidRemoteName);
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), GitError> {
    if url.trim().is_empty() || url.contains('\0') {
        return Err(GitError::InvalidRemoteUrl);
    }
    Ok(())
}

fn ensure_remote_exists(git: &git2::Repository, name: &str) -> Result<(), GitError> {
    git.find_remote(name)
        .map(|_| ())
        .map_err(|error| match error.code() {
            ErrorCode::NotFound => GitError::RemoteNotFound(name.to_string()),
            _ => GitError::Git2("remote lookup failed".into()),
        })
}

fn remote_value_count(git: &git2::Repository, remote: &str, key: &str) -> Result<usize, GitError> {
    let config = git.config().map_err(LocalGitBackend::map_git2_error)?;
    let mut count = 0;
    config
        .multivar(&format!("remote.{remote}.{key}"), None)
        .map_err(|_| GitError::InvalidRemoteUrl)?
        .for_each(|_| count += 1)
        .map_err(|_| GitError::InvalidRemoteUrl)?;
    Ok(count)
}

fn configured_upstream_branches(
    git: &git2::Repository,
    remote: &str,
) -> Result<Vec<String>, GitError> {
    let config = git.config().map_err(LocalGitBackend::map_git2_error)?;
    let mut entries = config
        .entries(Some("branch\\..+\\.remote"))
        .map_err(LocalGitBackend::map_git2_error)?;
    let mut branches = Vec::new();
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(LocalGitBackend::map_git2_error)?;
        if entry.value().map_err(LocalGitBackend::map_git2_error)? != remote {
            continue;
        }
        let key = entry.name().map_err(LocalGitBackend::map_git2_error)?;
        if let Some(branch) = key
            .strip_prefix("branch.")
            .and_then(|value| value.strip_suffix(".remote"))
        {
            branches.push(branch.to_string());
        }
    }
    branches.sort();
    branches.dedup();
    Ok(branches)
}

fn remote_info(git: &git2::Repository, name: &str) -> Result<RemoteInfo, GitError> {
    let remote = git.find_remote(name).map_err(|error| match error.code() {
        ErrorCode::NotFound => GitError::RemoteNotFound(name.to_string()),
        _ => GitError::Git2("remote lookup failed".into()),
    })?;
    let fetch_url = remote.url().map_err(|_| GitError::InvalidRemoteUrl)?;
    let push_url = remote
        .pushurl()
        .map_err(|_| GitError::InvalidRemoteUrl)?
        .map(sanitize_diagnostics);
    Ok(RemoteInfo {
        name: name.to_string(),
        fetch_url: sanitize_diagnostics(fetch_url),
        push_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fjord_domain::GenerationSet;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, RepoPath, LocalGitBackend) {
        let directory = TempDir::new().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        let repo = RepoPath::new(directory.path().to_path_buf());
        (directory, repo, LocalGitBackend::new())
    }

    fn config(directory: &TempDir) -> git2::Config {
        git2::Repository::open(directory.path())
            .unwrap()
            .config()
            .unwrap()
    }

    fn assert_config_only_increment(before: GenerationSet, after: GenerationSet) {
        assert_eq!(
            after,
            GenerationSet {
                config: before.config + 1,
                ..before
            }
        );
    }

    fn assert_refs_config_increment(before: GenerationSet, after: GenerationSet) {
        assert_eq!(
            after,
            GenerationSet {
                refs: before.refs + 1,
                config: before.config + 1,
                ..before
            }
        );
    }

    fn assert_refs_history_config_increment(before: GenerationSet, after: GenerationSet) {
        assert_eq!(
            after,
            GenerationSet {
                refs: before.refs + 1,
                history: before.history + 1,
                config: before.config + 1,
                ..before
            }
        );
    }

    fn create_remote_tracking_ref(directory: &TempDir, name: &str) {
        let git = git2::Repository::open(directory.path()).unwrap();
        let tree_id = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Fjord Test", "fjord@example.test").unwrap();
        let commit = git
            .commit(None, &signature, &signature, "remote tip", &tree, &[])
            .unwrap();
        git.reference(name, commit, true, "test remote-tracking ref")
            .unwrap();
    }

    struct FailingConfigCommitter;

    impl ConfigCommitter for FailingConfigCommitter {
        fn commit(self, marker: gix_lock::Marker) -> Result<(), GitError> {
            let staged = git2::Config::open(marker.lock_path()).unwrap();
            assert_eq!(
                staged.get_string("remote.origin.url").unwrap(),
                "https://new/repo.git"
            );
            assert_eq!(
                staged.get_string("remote.origin.pushurl").unwrap(),
                "ssh://new/repo.git"
            );
            Err(GitError::InvalidRemoteUrl)
        }
    }

    #[tokio::test]
    async fn list_and_add_preserve_config_and_redact_userinfo() {
        let (directory, repo, backend) = fixture();

        let before = backend.generations(&repo).unwrap();
        let added = backend
            .add_remote(
                &repo,
                "origin",
                "https://user:secret@example.test/team/repo.git",
            )
            .await
            .unwrap();
        let after_add = backend.generations(&repo).unwrap();
        assert_config_only_increment(before, after_add);
        assert_eq!(added.name, "origin");
        assert_eq!(
            added.fetch_url,
            "https://[REDACTED]@example.test/team/repo.git"
        );
        assert_eq!(backend.remotes(&repo).await.unwrap(), vec![added]);
        assert_eq!(
            git2::Repository::open(directory.path())
                .unwrap()
                .config()
                .unwrap()
                .get_string("remote.origin.url")
                .unwrap(),
            "https://user:secret@example.test/team/repo.git"
        );
        assert!(matches!(
            backend.add_remote(&repo, "origin", "other").await,
            Err(GitError::RemoteAlreadyExists(name)) if name == "origin"
        ));
        assert_eq!(backend.generations(&repo).unwrap(), after_add);
    }

    #[tokio::test]
    async fn set_url_writes_exact_values_clears_pushurl_and_preserves_other_config() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();
        let mut git_config = config(&directory);
        git_config
            .set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
            .unwrap();
        git_config
            .set_str("remote.origin.push", "refs/heads/main:refs/heads/mirror")
            .unwrap();
        git_config.set_bool("remote.origin.prune", true).unwrap();
        drop(git_config);
        backend
            .add_remote(&repo, "fork", "https://fork/repo.git")
            .await
            .unwrap();

        let before = backend.generations(&repo).unwrap();
        let edited = backend
            .set_remote_url(&repo, "origin", "https://new/repo.git", None)
            .await
            .unwrap();
        assert_eq!(edited.fetch_url, "https://new/repo.git");
        assert_eq!(edited.push_url, None);
        let after = backend.generations(&repo).unwrap();
        assert_config_only_increment(before, after);

        let git_config = config(&directory);
        assert_eq!(
            git_config.get_string("remote.origin.url").unwrap(),
            "https://new/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.origin.fetch").unwrap(),
            "+refs/heads/*:refs/remotes/origin/*"
        );
        assert_eq!(
            git_config.get_string("remote.origin.push").unwrap(),
            "refs/heads/main:refs/heads/mirror"
        );
        assert!(git_config.get_bool("remote.origin.prune").unwrap());
        assert_eq!(
            git_config.get_string("remote.fork.url").unwrap(),
            "https://fork/repo.git"
        );
        assert_eq!(
            git_config
                .get_string("remote.origin.pushurl")
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );

        let before = after;
        backend
            .set_remote_url(
                &repo,
                "origin",
                "https://fetch/repo.git",
                Some("ssh://push/repo.git"),
            )
            .await
            .unwrap();
        assert_config_only_increment(before, backend.generations(&repo).unwrap());
        let git_config = config(&directory);
        assert_eq!(
            git_config.get_string("remote.origin.url").unwrap(),
            "https://fetch/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.origin.pushurl").unwrap(),
            "ssh://push/repo.git"
        );

        backend
            .set_remote_url(&repo, "origin", "https://fetch/repo.git", None)
            .await
            .unwrap();
        assert_eq!(
            config(&directory)
                .get_string("remote.origin.pushurl")
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[tokio::test]
    async fn set_url_stores_credentials_but_returns_only_redacted_values() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();

        let edited = backend
            .set_remote_url(
                &repo,
                "origin",
                "https://user:secret@example.test/repo.git",
                Some("https://push-user:secret@example.test/repo.git"),
            )
            .await
            .unwrap();
        assert_eq!(edited.fetch_url, "https://[REDACTED]@example.test/repo.git");
        assert_eq!(
            edited.push_url.as_deref(),
            Some("https://[REDACTED]@example.test/repo.git")
        );
        let git_config = config(&directory);
        assert_eq!(
            git_config.get_string("remote.origin.url").unwrap(),
            "https://user:secret@example.test/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.origin.pushurl").unwrap(),
            "https://push-user:secret@example.test/repo.git"
        );

        let before = backend.generations(&repo).unwrap();
        let error = backend
            .set_remote_url(
                &repo,
                "missing",
                "https://user:secret@example.test/repo.git",
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(&error, GitError::RemoteNotFound(name) if name == "missing"));
        assert!(!format!("{error:?} {error}").contains("secret"));
        assert_eq!(backend.generations(&repo).unwrap(), before);
    }

    #[tokio::test]
    async fn set_url_rejects_multiple_push_urls_before_any_config_mutation() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();
        let mut git_config = config(&directory);
        git_config
            .set_multivar("remote.origin.pushurl", "^$", "ssh://server1/repo.git")
            .unwrap();
        git_config
            .set_multivar("remote.origin.pushurl", "^$", "ssh://server2/repo.git")
            .unwrap();
        drop(git_config);

        let config_path = git2::Repository::open(directory.path())
            .unwrap()
            .path()
            .join("config");
        let config_before = std::fs::read(&config_path).unwrap();
        let generations_before = backend.generations(&repo).unwrap();

        assert!(matches!(
            backend
                .set_remote_url(
                    &repo,
                    "origin",
                    "https://new/repo.git",
                    Some("ssh://new/repo.git"),
                )
                .await,
            Err(GitError::InvalidRemoteUrl)
        ));
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(backend.generations(&repo).unwrap(), generations_before);
    }

    #[tokio::test]
    async fn set_url_rejects_multiple_fetch_urls_before_any_config_mutation() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();
        let mut git_config = config(&directory);
        git_config
            .set_multivar("remote.origin.url", "^$", "https://mirror/repo.git")
            .unwrap();
        drop(git_config);

        let config_path = git2::Repository::open(directory.path())
            .unwrap()
            .path()
            .join("config");
        let config_before = std::fs::read(&config_path).unwrap();
        let generations_before = backend.generations(&repo).unwrap();

        assert!(matches!(
            backend
                .set_remote_url(
                    &repo,
                    "origin",
                    "https://new/repo.git",
                    Some("ssh://new/repo.git"),
                )
                .await,
            Err(GitError::InvalidRemoteUrl)
        ));
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(backend.generations(&repo).unwrap(), generations_before);
    }

    #[tokio::test]
    async fn set_url_transaction_failure_preserves_config_and_generations() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();
        config(&directory)
            .set_str("remote.origin.pushurl", "ssh://old/repo.git")
            .unwrap();

        let config_path = git2::Repository::open(directory.path())
            .unwrap()
            .path()
            .join("config");
        let config_before = std::fs::read(&config_path).unwrap();
        let generations_before = backend.generations(&repo).unwrap();

        assert!(matches!(
            set_url_with_committer(
                &repo,
                "origin",
                "https://new/repo.git",
                Some("ssh://new/repo.git"),
                FailingConfigCommitter,
            )
            .await,
            Err(GitError::InvalidRemoteUrl)
        ));
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(backend.generations(&repo).unwrap(), generations_before);
        let git_config = config(&directory);
        assert_eq!(
            git_config.get_string("remote.origin.url").unwrap(),
            "https://old/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.origin.pushurl").unwrap(),
            "ssh://old/repo.git"
        );
    }

    #[tokio::test]
    async fn rename_preserves_remote_config_and_updates_branch_upstream() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://fetch/repo.git")
            .await
            .unwrap();
        backend
            .add_remote(&repo, "taken", "https://taken/repo.git")
            .await
            .unwrap();
        let mut git_config = config(&directory);
        git_config
            .set_str("remote.origin.pushurl", "ssh://push/repo.git")
            .unwrap();
        git_config
            .set_str("remote.origin.push", "refs/heads/main:refs/heads/mirror")
            .unwrap();
        git_config.set_bool("remote.origin.prune", true).unwrap();
        git_config.set_str("branch.main.remote", "origin").unwrap();
        git_config
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();
        drop(git_config);
        create_remote_tracking_ref(&directory, "refs/remotes/origin/main");

        let config_path = git2::Repository::open(directory.path())
            .unwrap()
            .path()
            .join("config");
        let unchanged = std::fs::read(&config_path).unwrap();
        let before = backend.generations(&repo).unwrap();
        assert!(matches!(
            backend.rename_remote(&repo, "origin", "taken").await,
            Err(GitError::RemoteRenameTargetExists(name)) if name == "taken"
        ));
        assert_eq!(std::fs::read(&config_path).unwrap(), unchanged);
        assert_eq!(backend.generations(&repo).unwrap(), before);

        let renamed = backend
            .rename_remote(&repo, "origin", "upstream")
            .await
            .unwrap();
        assert_eq!(renamed.name, "upstream");
        assert_eq!(renamed.fetch_url, "https://fetch/repo.git");
        assert_eq!(renamed.push_url.as_deref(), Some("ssh://push/repo.git"));
        assert_refs_config_increment(before, backend.generations(&repo).unwrap());
        let git = git2::Repository::open(directory.path()).unwrap();
        assert!(git.find_reference("refs/remotes/origin/main").is_err());
        assert!(git.find_reference("refs/remotes/upstream/main").is_ok());

        let git_config = config(&directory);
        assert_eq!(
            git_config
                .get_string("remote.origin.url")
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            git_config.get_string("remote.upstream.url").unwrap(),
            "https://fetch/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.upstream.pushurl").unwrap(),
            "ssh://push/repo.git"
        );
        assert_eq!(
            git_config.get_string("remote.upstream.fetch").unwrap(),
            "+refs/heads/*:refs/remotes/upstream/*"
        );
        assert_eq!(
            git_config.get_string("remote.upstream.push").unwrap(),
            "refs/heads/main:refs/heads/mirror"
        );
        assert!(git_config.get_bool("remote.upstream.prune").unwrap());
        assert_eq!(
            git_config.get_string("branch.main.remote").unwrap(),
            "upstream"
        );
        assert_eq!(
            git_config.get_string("branch.main.merge").unwrap(),
            "refs/heads/main"
        );

        let before_noop = backend.generations(&repo).unwrap();
        assert_eq!(
            backend
                .rename_remote(&repo, "upstream", "upstream")
                .await
                .unwrap(),
            renamed
        );
        assert_eq!(backend.generations(&repo).unwrap(), before_noop);
    }

    #[tokio::test]
    async fn removal_preflight_lists_configured_upstreams_and_native_delete_clears_them() {
        let (directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://origin/repo.git")
            .await
            .unwrap();
        backend
            .add_remote(&repo, "fork", "https://fork/repo.git")
            .await
            .unwrap();
        backend
            .add_remote(&repo, "unused", "https://unused/repo.git")
            .await
            .unwrap();

        let empty = backend
            .preflight_remove_remote(&repo, "unused")
            .await
            .unwrap();
        assert!(empty.orphaned_upstreams.is_empty());

        let mut git_config = config(&directory);
        for (branch, remote) in [
            ("release", "origin"),
            ("main", "origin"),
            ("feature", "fork"),
            ("local", "."),
        ] {
            git_config
                .set_str(&format!("branch.{branch}.remote"), remote)
                .unwrap();
            git_config
                .set_str(
                    &format!("branch.{branch}.merge"),
                    &format!("refs/heads/{branch}"),
                )
                .unwrap();
        }
        drop(git_config);
        create_remote_tracking_ref(&directory, "refs/remotes/origin/main");

        let preflight = backend
            .preflight_remove_remote(&repo, "origin")
            .await
            .unwrap();
        assert_eq!(preflight.remote, "origin");
        assert_eq!(preflight.orphaned_upstreams, ["main", "release"]);
        let before = backend.generations(&repo).unwrap();
        assert_eq!(preflight.config_generation, before.config);

        backend
            .remove_remote(
                &repo,
                "origin",
                preflight.config_generation,
                &preflight.confirmation_token,
            )
            .await
            .unwrap();
        assert_refs_history_config_increment(before, backend.generations(&repo).unwrap());
        assert!(git2::Repository::open(directory.path())
            .unwrap()
            .find_reference("refs/remotes/origin/main")
            .is_err());

        let remotes = backend.remotes(&repo).await.unwrap();
        assert_eq!(
            remotes
                .iter()
                .map(|remote| remote.name.as_str())
                .collect::<Vec<_>>(),
            ["fork", "unused"]
        );
        let git_config = config(&directory);
        for branch in ["main", "release"] {
            assert_eq!(
                git_config
                    .get_string(&format!("branch.{branch}.remote"))
                    .unwrap_err()
                    .code(),
                ErrorCode::NotFound
            );
            assert_eq!(
                git_config
                    .get_string(&format!("branch.{branch}.merge"))
                    .unwrap_err()
                    .code(),
                ErrorCode::NotFound
            );
        }
        assert_eq!(
            git_config.get_string("branch.feature.remote").unwrap(),
            "fork"
        );
        assert_eq!(git_config.get_string("branch.local.remote").unwrap(), ".");
    }

    #[tokio::test]
    async fn stale_removal_preflight_fails_without_partial_mutation() {
        let (_directory, repo, backend) = fixture();
        backend
            .add_remote(&repo, "origin", "https://old/repo.git")
            .await
            .unwrap();
        let preflight = backend
            .preflight_remove_remote(&repo, "origin")
            .await
            .unwrap();
        backend
            .set_remote_url(&repo, "origin", "https://new/repo.git", None)
            .await
            .unwrap();
        let after_edit = backend.generations(&repo).unwrap();

        assert!(matches!(
            backend
                .remove_remote(
                    &repo,
                    "origin",
                    preflight.config_generation,
                    &preflight.confirmation_token,
                )
                .await,
            Err(GitError::PreflightStale)
        ));
        assert_eq!(backend.generations(&repo).unwrap(), after_edit);
        assert_eq!(backend.remotes(&repo).await.unwrap()[0].name, "origin");
    }

    #[tokio::test]
    async fn invalid_or_missing_mutations_do_not_advance_generations() {
        let (_directory, repo, backend) = fixture();
        let before = backend.generations(&repo).unwrap();
        assert!(matches!(
            backend
                .add_remote(&repo, "bad name", "https://example.test")
                .await,
            Err(GitError::InvalidRemoteName)
        ));
        assert!(matches!(
            backend.add_remote(&repo, "origin", " ").await,
            Err(GitError::InvalidRemoteUrl)
        ));
        assert!(matches!(
            backend
                .rename_remote(&repo, "missing", "upstream")
                .await,
            Err(GitError::RemoteNotFound(name)) if name == "missing"
        ));
        assert!(matches!(
            backend.preflight_remove_remote(&repo, "missing").await,
            Err(GitError::RemoteNotFound(name)) if name == "missing"
        ));
        assert_eq!(backend.generations(&repo).unwrap(), before);
    }
}
