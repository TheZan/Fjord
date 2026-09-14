use std::path::Path;
use std::process::{Command, Stdio};

use async_trait::async_trait;
use fjord_domain::OpenTarget;
use fjord_ports::{IdeLauncher, LaunchError};

pub struct SystemIdeLauncher;

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchCommand {
    program: String,
}

impl LaunchCommand {
    fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }
}

#[async_trait]
impl IdeLauncher for SystemIdeLauncher {
    async fn open(&self, path: &Path, ide: Option<&str>) -> Result<(), LaunchError> {
        let command = resolve_launch_command(ide)?;
        spawn_ide(&command, path)
    }

    async fn open_terminal(&self, path: &Path) -> Result<(), LaunchError> {
        spawn_terminal(path)
    }

    async fn open_path(
        &self,
        path: &Path,
        target: OpenTarget,
        ide: Option<&str>,
    ) -> Result<(), LaunchError> {
        match target {
            OpenTarget::ConfiguredEditor { line } => {
                let command = resolve_launch_command(ide)?;
                spawn_ide_at(&command, path, line)
            }
            OpenTarget::DefaultApplication => spawn_default_application(path),
        }
    }

    async fn reveal_path(&self, path: &Path) -> Result<(), LaunchError> {
        spawn_reveal(path)
    }
}

// VS Code, Cursor, and Windsurf all install their CLI as a `.cmd` shim on
// Windows, not a `.exe`. `Command::new` calls `CreateProcess` directly and
// — unlike `cmd.exe`'s own command resolution — never resolves `.cmd`/`.bat`,
// so launching "code" this way fails with a plain "program not found" even
// though `where code` finds it (rust-lang/rust#37519). Route through `cmd
// /C`, same as `spawn_terminal` below, so the same PATHEXT-aware lookup
// `where` used to report the IDE as available is what actually launches it.
#[cfg(windows)]
fn spawn_ide(command: &LaunchCommand, path: &Path) -> Result<(), LaunchError> {
    spawn_ide_at(command, path, None)
}

#[cfg(windows)]
fn spawn_ide_at(
    command: &LaunchCommand,
    path: &Path,
    line: Option<u32>,
) -> Result<(), LaunchError> {
    let arguments = ide_path_arguments(command, path, line);
    Command::new("cmd")
        .args(["/C", &command.program])
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
}

#[cfg(not(windows))]
fn spawn_ide(command: &LaunchCommand, path: &Path) -> Result<(), LaunchError> {
    spawn_ide_at(command, path, None)
}

#[cfg(not(windows))]
fn spawn_ide_at(
    command: &LaunchCommand,
    path: &Path,
    line: Option<u32>,
) -> Result<(), LaunchError> {
    Command::new(&command.program)
        .args(ide_path_arguments(command, path, line))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
}

fn ide_path_arguments(
    command: &LaunchCommand,
    path: &Path,
    line: Option<u32>,
) -> Vec<std::ffi::OsString> {
    let Some(line) = line else {
        return vec![path.as_os_str().to_owned()];
    };
    match command.program.as_str() {
        "code" | "code-insiders" | "cursor" | "windsurf" | "zed" => {
            vec!["--goto".into(), format!("{}:{line}", path.display()).into()]
        }
        "idea" | "webstorm" | "pycharm" | "clion" | "rider" | "rustrover" => vec![
            "--line".into(),
            line.to_string().into(),
            path.as_os_str().to_owned(),
        ],
        _ => vec![path.as_os_str().to_owned()],
    }
}

#[cfg(windows)]
fn spawn_default_application(path: &Path) -> Result<(), LaunchError> {
    spawn_detached(Command::new("explorer.exe").arg(path))
}

#[cfg(target_os = "macos")]
fn spawn_default_application(path: &Path) -> Result<(), LaunchError> {
    spawn_detached(Command::new("open").arg(path))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_default_application(path: &Path) -> Result<(), LaunchError> {
    spawn_detached(Command::new("xdg-open").arg(path))
}

#[cfg(windows)]
fn spawn_reveal(path: &Path) -> Result<(), LaunchError> {
    let mut argument = std::ffi::OsString::from("/select,");
    argument.push(path);
    spawn_detached(Command::new("explorer.exe").arg(argument))
}

#[cfg(target_os = "macos")]
fn spawn_reveal(path: &Path) -> Result<(), LaunchError> {
    spawn_detached(Command::new("open").arg("-R").arg(path))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_reveal(path: &Path) -> Result<(), LaunchError> {
    let parent = path.parent().ok_or_else(|| {
        LaunchError::SpawnFailed("repository file has no parent directory".into())
    })?;
    spawn_detached(Command::new("xdg-open").arg(parent))
}

fn spawn_detached(command: &mut Command) -> Result<(), LaunchError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| LaunchError::SpawnFailed(error.to_string()))
}

#[cfg(target_os = "macos")]
fn spawn_terminal(path: &Path) -> Result<(), LaunchError> {
    Command::new("open")
        .args(["-a", "Terminal"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
}

#[cfg(windows)]
fn spawn_terminal(path: &Path) -> Result<(), LaunchError> {
    // `start` is a cmd builtin, so it has to run *through* cmd. The empty
    // first argument is `start`'s window-title slot — without it a quoted
    // path would be swallowed as the title.
    Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K", "cd", "/d"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_terminal(path: &Path) -> Result<(), LaunchError> {
    let terminal = known_terminal_commands()
        .iter()
        .find(|candidate| command_available(candidate))
        .ok_or(LaunchError::NoTerminalAvailable)?;

    Command::new(terminal)
        .arg("--working-directory")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn known_terminal_commands() -> &'static [&'static str] {
    &[
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
    ]
}

/// Prefix that turns an arbitrary `ide` value into an intentional custom
/// editor. Anything else must resolve through the allowlist below — an
/// unrecognized bare string is rejected instead of being executed as a
/// program name (docs/tasks.md P4-04, SDD §9).
const CUSTOM_IDE_PREFIX: &str = "custom:";

fn resolve_launch_command(ide: Option<&str>) -> Result<LaunchCommand, LaunchError> {
    if let Some(ide) = ide.map(str::trim).filter(|ide| !ide.is_empty()) {
        if let Some(custom) = ide.strip_prefix(CUSTOM_IDE_PREFIX) {
            let custom = custom.trim();
            if custom.is_empty() {
                return Err(LaunchError::IdeNotAllowed(ide.to_string()));
            }
            return Ok(LaunchCommand::new(custom));
        }

        let normalized = ide.to_ascii_lowercase();
        let command = ide_command(&normalized);
        return known_ide_commands()
            .iter()
            .find(|candidate| **candidate == command)
            .map(|candidate| LaunchCommand::new(*candidate))
            .ok_or_else(|| LaunchError::IdeNotAllowed(ide.to_string()));
    }

    for candidate in known_ide_commands() {
        if command_available(candidate) {
            return Ok(LaunchCommand::new(*candidate));
        }
    }

    Err(LaunchError::NoIdeAvailable)
}

fn ide_command(ide: &str) -> &str {
    match ide {
        "vscode" | "visual-studio-code" => "code",
        "vscode-insiders" => "code-insiders",
        "intellij" => "idea",
        other => other,
    }
}

/// The allowlist of launchable IDE CLI commands. `resolve_launch_command`
/// only ever spawns one of these (or an explicit `custom:` editor).
fn known_ide_commands() -> &'static [&'static str] {
    &[
        "code",
        "code-insiders",
        "cursor",
        "windsurf",
        "zed",
        "idea",
        "webstorm",
        "pycharm",
        "clion",
        "rider",
        "rustrover",
    ]
}

#[cfg(windows)]
fn command_available(command: &str) -> bool {
    Command::new("where")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Shell-free `command -v` replacement: walks `PATH` directly instead of
/// interpolating the name into `sh -c` (P4-04 — the old pattern was one
/// unsanitized caller away from a shell injection).
#[cfg(not(windows))]
fn command_available(command: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fn is_executable(path: &Path) -> bool {
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    if command.contains('/') {
        return is_executable(Path::new(command));
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| is_executable(&dir.join(command)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_ide_aliases_map_to_cli_commands() {
        assert_eq!(
            resolve_launch_command(Some("vscode")).unwrap(),
            LaunchCommand::new("code")
        );
        assert_eq!(
            resolve_launch_command(Some("IntelliJ")).unwrap(),
            LaunchCommand::new("idea")
        );
    }

    #[test]
    fn known_ide_commands_pass_the_allowlist() {
        assert_eq!(
            resolve_launch_command(Some("code-insiders")).unwrap(),
            LaunchCommand::new("code-insiders")
        );
        assert_eq!(
            resolve_launch_command(Some("RustRover")).unwrap(),
            LaunchCommand::new("rustrover")
        );
    }

    #[test]
    fn unknown_ide_is_rejected() {
        assert!(matches!(
            resolve_launch_command(Some("evil; rm -rf /")),
            Err(LaunchError::IdeNotAllowed(_))
        ));
        assert!(matches!(
            resolve_launch_command(Some("custom-editor")),
            Err(LaunchError::IdeNotAllowed(_))
        ));
    }

    #[test]
    fn custom_prefix_is_the_explicit_escape_hatch() {
        assert_eq!(
            resolve_launch_command(Some("custom:my-editor")).unwrap(),
            LaunchCommand::new("my-editor")
        );
        assert!(matches!(
            resolve_launch_command(Some("custom:   ")),
            Err(LaunchError::IdeNotAllowed(_))
        ));
    }

    #[test]
    fn file_launch_arguments_include_a_line_only_for_editors_that_support_it() {
        let path = Path::new("C:/repo/src/main.rs");
        assert_eq!(
            ide_path_arguments(&LaunchCommand::new("code"), path, Some(147)),
            vec![
                std::ffi::OsString::from("--goto"),
                std::ffi::OsString::from("C:/repo/src/main.rs:147"),
            ]
        );
        assert_eq!(
            ide_path_arguments(&LaunchCommand::new("rider"), path, Some(147)),
            vec![
                std::ffi::OsString::from("--line"),
                std::ffi::OsString::from("147"),
                path.as_os_str().to_owned(),
            ]
        );
        assert_eq!(
            ide_path_arguments(&LaunchCommand::new("custom-editor"), path, Some(147)),
            vec![path.as_os_str().to_owned()]
        );
    }
}
