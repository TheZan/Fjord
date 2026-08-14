# Fjord v0.1.0 — Early Preview

Fjord is a cross-platform, workspace-first Git desktop application. It groups
multiple local repositories into workspaces, summarizes which ones need
attention, and keeps detailed repository history, changes, and recovery tools in
the same application.

> **Early Preview:** v0.1 is intended for evaluation and everyday workflows
> where users retain normal Git backups and review safety prompts. It is not a
> stable-support promise.

## Supported platforms

- Windows 11 x64: NSIS installer.
- macOS 13 or newer: package for Intel and Apple Silicon.
- Ubuntu 22.04 or newer x64: AppImage.

Packages are not code-signed for v0.1: Windows SmartScreen and macOS
Gatekeeper will show an unknown-publisher warning on first run (Windows:
"More info" → "Run anyway"; macOS: allow the app under System Settings →
Privacy & Security, or run `xattr -cr` on it). This does not affect update
security — every update artifact is still cryptographically signed and
verified by the mandatory Tauri updater key regardless of platform signing.

The exact candidate is eligible only after all three packages and the
[clean-machine smoke matrix](../v0.1-fresh-install-smoke.md) pass. Remote
operations require an installed system Git; local repository reads remain
available when network access is unavailable.

## What is included

- Create and organize workspaces; open or scan for existing repositories.
- Clone a plain Git URL or create a local repository with an unborn `main` (or
  another valid initial branch).
- Workspace status, bulk fetch/pull/open-in-IDE, repository switching, command
  palette, and global repository/branch/commit search.
- Branch and tag views, paged commit graph/history, commit inspector, working
  changes, bounded diffs, staged/unstaged files, and partial-hunk operations.
- Commit and amend; branch, tag, and stash workflows; checkout protection for
  local changes.
- List/add a remote, explicitly **Push & Set Upstream**, push the current branch
  to several selected remotes without changing upstream, fetch, pull, push, and
  authenticate through the installed Git credential helpers, SSH config, and
  Fjord's one-use askpass prompt.
- Detection and control of interrupted Git operations, destructive preflight
  summaries, force-with-lease protection, and reflog-based Recovery Center.
- English, Russian, German, French, and Spanish UI; light, dark, and system themes.

## Workspace-first workflow

Unlike a single-repository-first client, Fjord opens on a workspace overview.
Repositories remain independent on disk, while their branch, ahead/behind,
dirty, and conflict states are summarized together. Bulk actions are bounded and
report a result per repository; opening one repository reveals its full history
and working tree without losing the workspace context.

## Important limitations

- No GitHub/GitLab account integration, OAuth, provider-side repository
  creation, pull-request or issue management.
- Remote management is intentionally limited to list/add in v0.1. URL editing,
  rename, remove, generalized remote pickers, and full CRUD are not included.
- No worktree management, interactive rebase editor, plugins, cloud sync, or
  team collaboration. Fjord can detect and help continue/skip/abort an existing
  rebase but does not yet start the Phase 10 rebase workflow.
- Linux is distributed as an AppImage; there is no signed apt/rpm repository.
- The updater plugin is packaged and signed metadata is produced, but v0.1 does
  not perform background update checks or automatic installation.
- Performance evidence is fixture- and scenario-specific. v0.1 makes no claim
  that every very large or unusual repository will meet a universal latency or
  memory target.

## Safety expectations

Keep normal backups for valuable work. Fjord validates repository snapshots
before mutations, never stores Git credentials, uses installed system Git for
network transport, and presents consequence/recoverability facts before
destructive actions. Force is never implicit: force-with-lease requires its own
fresh confirmation bound to the observed remote state.

Recovery Center uses Git reflogs. It can help recover reachable recorded states,
but it cannot restore work that was never committed or stashed, expired reflog
entries, consumed stash entries, or remote history removed outside Fjord. Read
each preflight and do not proceed when the repository facts are unexpected.

## Reporting bugs and security issues

Use the [bug report form](https://github.com/TheZan/Fjord/issues/new?template=bug_report.yml)
for reproducible non-security problems. Include Fjord version, OS, minimal steps,
expected/actual behavior, and only bounded sanitized logs. Do not attach private
repository contents, full diffs, credentials, signing keys, or URLs with userinfo.

Report vulnerabilities privately through the
[security advisory form](https://github.com/TheZan/Fjord/security/advisories/new)
as described in [`SECURITY.md`](../../SECURITY.md).

## Installation and verification

Download only artifacts attached to the `v0.1.0` GitHub Release after its public
launch decision is **READY FOR v0.1 PUBLIC EARLY PREVIEW**. Verify the published
filename and checksum evidence for your platform. Source-build prerequisites and
commands are in the root [`README.md`](../../README.md).

The release decision links same-SHA CI, signed artifact checks, askpass bundle
inspection, clean-machine/fresh-install evidence, public-repository audit, and
this populated note. A draft release or a locally built package is not equivalent
to a passed public launch gate.
