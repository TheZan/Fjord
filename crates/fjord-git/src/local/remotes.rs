use super::*;
use crate::remote::errors::sanitize_diagnostics;

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
    let repo = repo.clone();
    let name = name.to_string();
    let url = url.to_string();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            if git.find_remote(&name).is_ok() {
                return Err(GitError::RemoteAlreadyExists(name));
            }
            git.remote(&name, &url)
                .map_err(|error| match error.code() {
                    ErrorCode::Exists => GitError::RemoteAlreadyExists(name.clone()),
                    _ => GitError::InvalidRemote(error.message().to_string()),
                })?;
            remote_info(git, &name)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn remote_info(git: &git2::Repository, name: &str) -> Result<RemoteInfo, GitError> {
    let remote = git
        .find_remote(name)
        .map_err(LocalGitBackend::map_git2_error)?;
    let fetch_url = remote.url().map_err(LocalGitBackend::map_git2_error)?;
    let push_url = remote
        .pushurl()
        .map_err(LocalGitBackend::map_git2_error)?
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
    use tempfile::TempDir;

    #[tokio::test]
    async fn list_and_add_preserve_config_and_redact_userinfo() {
        let directory = TempDir::new().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        let repo = RepoPath::new(directory.path().to_path_buf());
        let backend = LocalGitBackend::new();

        let added = backend
            .add_remote(
                &repo,
                "origin",
                "https://user:secret@example.test/team/repo.git",
            )
            .await
            .unwrap();
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
    }
}
