//! `open_external_diff` and its availability check (`P10-WC-06`). The merge
//! tool and the diff tool are deliberately separate concepts (§6.4): this
//! module never touches `merge.tool` or `git mergetool`.

use std::collections::HashSet;

use fjord_domain::PatchSource;
use fjord_ports::{GitError, RepoPath};

use crate::executable::GitCommandFactory;
use crate::local::LocalGitBackend;

/// Parses `git difftool --tool-help` output into the set of tool names Git
/// recognizes, whether or not the underlying binary happens to be installed
/// on this machine — that's exactly the "Git can resolve `name`" contract
/// §6.4 asks for, not "the GUI is present". Tool lines are indented two
/// tabs; everything else (headers, the `user-defined:` subheading, the
/// trailing prose) is not. A user-defined tool's line is `<name>.cmd <cmd>`,
/// so a `.cmd` suffix on the first token is stripped back to the real name.
fn parse_tool_help(output: &str) -> HashSet<String> {
    output
        .lines()
        .filter(|line| line.starts_with("\t\t"))
        .filter_map(|line| line.trim().split_whitespace().next())
        .map(|token| token.strip_suffix(".cmd").unwrap_or(token).to_string())
        .collect()
}

fn resolvable_tools_blocking(
    commands: &GitCommandFactory,
    repo: &RepoPath,
) -> Result<HashSet<String>, GitError> {
    let output = commands
        .command()?
        .args(["difftool", "--tool-help"])
        .current_dir(&repo.0)
        .output()
        .map_err(|error| GitError::Git2(error.to_string()))?;
    Ok(parse_tool_help(&String::from_utf8_lossy(&output.stdout)))
}

fn configured_diff_tool(repo: &RepoPath) -> Result<bool, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let config = git
            .config()
            .map_err(|error| GitError::Git2(error.to_string()))?;
        Ok(config.get_string("diff.tool").is_ok())
    })
}

fn resolves(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    preference: Option<&str>,
) -> Result<bool, GitError> {
    match preference {
        None => configured_diff_tool(repo),
        Some(name) => Ok(resolvable_tools_blocking(commands, repo)?.contains(name)),
    }
}

/// Pure argument construction per §6.4's table: `--no-prompt` always; a
/// stored preference adds `--tool=<name>`; a staged row adds `--cached` so
/// the invocation diffs `HEAD -> INDEX` rather than the worktree, matching
/// §6.1's row-identity rule.
fn build_args(path: &str, source: PatchSource, preference: Option<&str>) -> Vec<String> {
    let mut args = vec!["difftool".to_string(), "--no-prompt".to_string()];
    if let Some(name) = preference {
        args.push(format!("--tool={name}"));
    }
    if source == PatchSource::Index {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(path.to_string());
    args
}

pub(super) async fn availability(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    preference: Option<&str>,
) -> Result<bool, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let preference = preference.map(ToString::to_string);
    tokio::task::spawn_blocking(move || resolves(&commands, &repo, preference.as_deref()))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn open(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    path: &str,
    source: PatchSource,
    preference: Option<&str>,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let path = path.to_string();
    let preference = preference.map(ToString::to_string);
    tokio::task::spawn_blocking(move || {
        if !resolves(&commands, &repo, preference.as_deref())? {
            return Err(GitError::DiffToolNotConfigured {
                tool: preference
                    .clone()
                    .unwrap_or_else(|| "diff.tool".to_string()),
            });
        }

        commands
            .command()?
            .args(build_args(&path, source, preference.as_deref()))
            .current_dir(&repo.0)
            .spawn()
            .map(|_| ())
            .map_err(|error| GitError::Git2(error.to_string()))
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_help_including_configured_and_built_in_names() {
        let output = "\
'git difftool --tool=<tool>' may be set to one of the following:\n\
\t\tvimdiff          Use Vim\n\
\t\tvscode           Use Visual Studio Code (requires a graphical session)\n\
\n\
\tuser-defined:\n\
\t\tmytool.cmd true\n\
\n\
The following tools are valid, but not currently available:\n\
\t\tmeld             Use Meld (requires a graphical session)\n\
\n\
Some of the tools listed above only work in a windowed\n\
environment. If run in a terminal-only session, they will fail.\n";

        let tools = parse_tool_help(output);
        assert!(tools.contains("vimdiff"));
        assert!(tools.contains("vscode"));
        assert!(tools.contains("mytool"));
        assert!(tools.contains("meld"));
        assert!(!tools.contains("user-defined:"));
    }

    #[test]
    fn empty_output_resolves_nothing() {
        assert!(parse_tool_help("").is_empty());
    }

    #[test]
    fn unstaged_auto_omits_tool_and_cached() {
        assert_eq!(
            build_args("src/app.rs", PatchSource::Worktree, None),
            vec!["difftool", "--no-prompt", "--", "src/app.rs"]
        );
    }

    #[test]
    fn staged_auto_adds_cached_but_no_tool() {
        assert_eq!(
            build_args("src/app.rs", PatchSource::Index, None),
            vec!["difftool", "--no-prompt", "--cached", "--", "src/app.rs"]
        );
    }

    #[test]
    fn unstaged_named_tool_adds_tool_but_no_cached() {
        assert_eq!(
            build_args("src/app.rs", PatchSource::Worktree, Some("meld")),
            vec!["difftool", "--no-prompt", "--tool=meld", "--", "src/app.rs"]
        );
    }

    #[test]
    fn staged_named_tool_adds_both_tool_and_cached() {
        assert_eq!(
            build_args("src/app.rs", PatchSource::Index, Some("meld")),
            vec![
                "difftool",
                "--no-prompt",
                "--tool=meld",
                "--cached",
                "--",
                "src/app.rs",
            ]
        );
    }
}
