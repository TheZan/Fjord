//! The single source of the `git` binary Fjord runs.
//!
//! Remote transport resolves its executable per operation from the settings
//! carried on `GitOperationContext`. Local operations have no such context, so
//! they read the same resolved path from here — otherwise a user who points
//! Fjord at a specific Git would keep cherry-picking, resetting, and tagging
//! with whatever `PATH` happens to hold, possibly a different version.
//!
//! When resolution fails there is no fallback. `Unavailable` makes local
//! subprocess commands fail with the same condition remote transport reports,
//! so one bad setting cannot leave half the application on a different Git
//! (docs/tasks.md P5-20).

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, RwLock};

use fjord_ports::{GitError, GitExecutableResolution};

/// The executable state local commands run against.
#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    /// Nothing has been resolved yet: run `git` from `PATH`. This is the
    /// initial state so tests and `fjord-bench` work without any wiring; the
    /// application replaces it during bootstrap.
    PathDefault,
    Resolved(PathBuf),
    Unavailable,
}

/// Shared, cheaply cloneable handle to the executable local Git commands use.
#[derive(Debug, Clone)]
pub struct GitCommandFactory {
    state: Arc<RwLock<State>>,
}

impl Default for GitCommandFactory {
    fn default() -> Self {
        Self {
            state: Arc::new(RwLock::new(State::PathDefault)),
        }
    }
}

impl GitCommandFactory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies a resolution produced by executable discovery. Callers pass an
    /// already-validated path — this type does no discovery of its own.
    pub fn apply(&self, resolution: GitExecutableResolution) {
        let next = match resolution {
            GitExecutableResolution::Resolved(path) => State::Resolved(path),
            GitExecutableResolution::Unavailable => State::Unavailable,
        };
        *self.write() = next;
    }

    pub fn executable(&self) -> Result<PathBuf, GitError> {
        match &*self.read() {
            State::PathDefault => Ok(PathBuf::from("git")),
            State::Resolved(path) => Ok(path.clone()),
            State::Unavailable => Err(GitError::ExecutableNotFound),
        }
    }

    /// A blocking command with no console window on Windows. Local Git work
    /// runs inside `spawn_blocking`, so it does not use the async runner.
    pub fn command(&self) -> Result<Command, GitError> {
        let mut command = Command::new(self.executable()?);
        suppress_console_window(&mut command);
        Ok(command)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> {
        self.state
            .read()
            .expect("git executable lock should not be poisoned")
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, State> {
        self.state
            .write()
            .expect("git executable lock should not be poisoned")
    }
}

// Taking `&mut` in both variants keeps the binding used on every platform; an
// inline `#[cfg(windows)]` block instead leaves `mut` unused elsewhere, which
// is a hard error under `-D warnings`.
#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_path_and_follows_the_configured_executable() {
        let factory = GitCommandFactory::new();
        assert_eq!(factory.executable().unwrap(), PathBuf::from("git"));

        let configured = PathBuf::from("/opt/custom/bin/git");
        factory.apply(GitExecutableResolution::Resolved(configured.clone()));
        assert_eq!(factory.executable().unwrap(), configured);
        assert_eq!(
            factory.command().unwrap().get_program(),
            configured.as_os_str(),
            "commands must be built from the configured executable"
        );
    }

    #[test]
    fn an_unavailable_executable_fails_instead_of_falling_back_to_path() {
        let factory = GitCommandFactory::new();
        factory.apply(GitExecutableResolution::Unavailable);

        assert!(matches!(
            factory.executable(),
            Err(GitError::ExecutableNotFound)
        ));
        assert!(matches!(
            factory.command(),
            Err(GitError::ExecutableNotFound)
        ));
    }

    #[test]
    fn clones_share_one_setting() {
        // The app configures the factory it handed to the backend, not a copy
        // that drifts.
        let factory = GitCommandFactory::new();
        let clone = factory.clone();
        clone.apply(GitExecutableResolution::Unavailable);

        assert!(matches!(
            factory.executable(),
            Err(GitError::ExecutableNotFound)
        ));
    }
}
