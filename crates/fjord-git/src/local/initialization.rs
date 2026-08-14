use super::*;

pub(super) async fn init_repository(
    destination: &RepoPath,
    initial_branch: &str,
) -> Result<(), GitError> {
    let destination = destination.clone();
    let initial_branch = initial_branch.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&destination).await;

    tokio::task::spawn_blocking(move || initialize_blocking(&destination, &initial_branch))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

fn initialize_blocking(destination: &RepoPath, initial_branch: &str) -> Result<(), GitError> {
    let reference_name = format!("refs/heads/{initial_branch}");
    if initial_branch.is_empty()
        || initial_branch.contains('\0')
        || !git2::Reference::is_valid_name(&reference_name)
    {
        return Err(GitError::InvalidRepositoryInitialization(
            "initial branch is not a valid branch name".into(),
        ));
    }

    let parent = destination.0.parent().ok_or_else(|| {
        GitError::RepositoryDestinationInvalid("destination has no parent directory".into())
    })?;
    if !parent.is_dir() {
        return Err(GitError::RepositoryDestinationInvalid(
            "destination parent is not a directory".into(),
        ));
    }
    validate_destination(&destination.0)?;

    let staging = parent.join(format!(".fjord-init-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|error| {
        GitError::RepositoryDestinationInvalid(format!(
            "could not create initialization staging directory: {error}"
        ))
    })?;

    let result = initialize_and_publish(&staging, &destination.0, initial_branch);
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn initialize_and_publish(
    staging: &std::path::Path,
    destination: &std::path::Path,
    initial_branch: &str,
) -> Result<(), GitError> {
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head(initial_branch);
    let repository =
        git2::Repository::init_opts(staging, &options).map_err(LocalGitBackend::map_git2_error)?;
    drop(repository);

    // Revalidate immediately before publication. Initialization happened in
    // an app-owned sibling, so every failure before this point leaves the
    // requested target unchanged.
    match std::fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::rename(staging, destination).map_err(|error| {
                GitError::RepositoryDestinationInvalid(format!(
                    "could not publish initialized repository: {error}"
                ))
            })?;
        }
        Ok(metadata) if metadata.is_dir() => {
            if std::fs::read_dir(destination)
                .map_err(|error| GitError::RepositoryDestinationInvalid(error.to_string()))?
                .next()
                .is_some()
            {
                return Err(GitError::RepositoryDestinationNotEmpty);
            }
            std::fs::rename(staging.join(".git"), destination.join(".git")).map_err(|error| {
                GitError::RepositoryDestinationInvalid(format!(
                    "could not publish initialized repository: {error}"
                ))
            })?;
        }
        Ok(_) => {
            return Err(GitError::RepositoryDestinationInvalid(
                "destination is not a directory".into(),
            ));
        }
        Err(error) => {
            return Err(GitError::RepositoryDestinationInvalid(error.to_string()));
        }
    }

    Ok(())
}

fn validate_destination(destination: &std::path::Path) -> Result<(), GitError> {
    match std::fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.is_dir() => {
            let mut entries = std::fs::read_dir(destination)
                .map_err(|error| GitError::RepositoryDestinationInvalid(error.to_string()))?;
            if entries.next().is_some() {
                Err(GitError::RepositoryDestinationNotEmpty)
            } else {
                Ok(())
            }
        }
        Ok(_) => Err(GitError::RepositoryDestinationInvalid(
            "destination is not a directory".into(),
        )),
        Err(error) => Err(GitError::RepositoryDestinationInvalid(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn initializes_new_and_existing_empty_directories_with_unborn_main() {
        let root = TempDir::new().unwrap();
        let backend = LocalGitBackend::new();

        for destination in [root.path().join("new"), root.path().join("empty")] {
            if destination.ends_with("empty") {
                std::fs::create_dir(&destination).unwrap();
            }
            let repo = RepoPath::new(destination.clone());
            backend.init_repository(&repo, "main").await.unwrap();

            let repository = git2::Repository::open(&destination).unwrap();
            let head = match repository.head() {
                Ok(_) => panic!("HEAD must be unborn"),
                Err(error) => error,
            };
            assert_eq!(head.code(), git2::ErrorCode::UnbornBranch);
            assert!(!repository.head_detached().unwrap());
            assert_eq!(
                repository.find_reference("HEAD").unwrap().symbolic_target(),
                Ok(Some("refs/heads/main"))
            );
        }
    }

    #[tokio::test]
    async fn rejects_non_empty_and_invalid_requests_without_partial_targets() {
        let root = TempDir::new().unwrap();
        let backend = LocalGitBackend::new();
        let non_empty = root.path().join("occupied");
        std::fs::create_dir(&non_empty).unwrap();
        std::fs::write(non_empty.join("keep.txt"), "keep").unwrap();

        assert!(matches!(
            backend
                .init_repository(&RepoPath::new(non_empty.clone()), "main")
                .await,
            Err(GitError::RepositoryDestinationNotEmpty)
        ));
        assert_eq!(
            std::fs::read_to_string(non_empty.join("keep.txt")).unwrap(),
            "keep"
        );

        let invalid_target = root.path().join("invalid");
        assert!(matches!(
            backend
                .init_repository(&RepoPath::new(invalid_target.clone()), "bad branch")
                .await,
            Err(GitError::InvalidRepositoryInitialization(_))
        ));
        assert!(!invalid_target.exists());
        assert!(std::fs::read_dir(root.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fjord-init-")));
    }
}
