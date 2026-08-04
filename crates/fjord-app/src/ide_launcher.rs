use std::path::Path;
use std::process::{Command, Stdio};

use async_trait::async_trait;
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
        Command::new(&command.program)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| LaunchError::SpawnFailed(e.to_string()))
    }
}

fn resolve_launch_command(ide: Option<&str>) -> Result<LaunchCommand, LaunchError> {
    if let Some(ide) = ide.and_then(normalize_ide) {
        return Ok(LaunchCommand::new(ide_command(&ide)));
    }

    for candidate in known_ide_commands() {
        if command_available(candidate) {
            return Ok(LaunchCommand::new(*candidate));
        }
    }

    Err(LaunchError::NoIdeAvailable)
}

fn normalize_ide(ide: &str) -> Option<String> {
    let trimmed = ide.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_ascii_lowercase())
}

fn ide_command(ide: &str) -> &str {
    match ide {
        "vscode" | "visual-studio-code" => "code",
        "vscode-insiders" | "code-insiders" => "code-insiders",
        "intellij" | "idea" => "idea",
        other => other,
    }
}

fn known_ide_commands() -> &'static [&'static str] {
    &[
        "code",
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

#[cfg(not(windows))]
fn command_available(command: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {command}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
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
    fn explicit_custom_ide_is_allowed() {
        assert_eq!(
            resolve_launch_command(Some("custom-editor")).unwrap(),
            LaunchCommand::new("custom-editor")
        );
    }
}
