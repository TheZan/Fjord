//! The single source of the `git` binary Fjord runs.
//!
//! Remote transport resolves its executable per operation from the settings
//! carried on `GitOperationContext`. Local operations have no such context, so
//! they read the same resolved path from here — otherwise a user who points
//! Fjord at a specific Git would keep cherry-picking, resetting, and tagging
//! with whatever `PATH` happens to hold, possibly a different version.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, RwLock};

/// Shared, cheaply cloneable handle to the executable local Git commands use.
/// Empty until the application applies the resolved path, which keeps tests and
/// benchmarks on the `PATH` default without any wiring.
#[derive(Debug, Clone, Default)]
pub struct GitCommandFactory {
    executable: Arc<RwLock<Option<PathBuf>>>,
}

impl GitCommandFactory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Points every later local Git command at `path`. `None` restores the
    /// `PATH` lookup. Callers pass an already-validated path — this type does
    /// no discovery of its own.
    pub fn set_executable(&self, path: Option<PathBuf>) {
        *self
            .executable
            .write()
            .expect("git executable lock should not be poisoned") = path;
    }

    pub fn executable(&self) -> PathBuf {
        self.executable
            .read()
            .expect("git executable lock should not be poisoned")
            .clone()
            .unwrap_or_else(|| PathBuf::from("git"))
    }

    /// A blocking command with no console window on Windows. Local Git work
    /// runs inside `spawn_blocking`, so it does not use the async runner.
    pub fn command(&self) -> Command {
        let mut command = Command::new(self.executable());
        suppress_console_window(&mut command);
        command
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
    fn falls_back_to_path_and_follows_the_configured_executable() {
        let factory = GitCommandFactory::new();
        assert_eq!(factory.executable(), PathBuf::from("git"));

        let configured = PathBuf::from("/opt/custom/bin/git");
        factory.set_executable(Some(configured.clone()));
        assert_eq!(factory.executable(), configured);
        assert_eq!(
            factory.command().get_program(),
            configured.as_os_str(),
            "commands must be built from the configured executable"
        );

        // Clones share one setting: the app configures the factory it handed
        // to the backend, not a copy that drifts.
        let clone = factory.clone();
        clone.set_executable(None);
        assert_eq!(factory.executable(), PathBuf::from("git"));
    }
}
