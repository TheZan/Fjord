# Fjord v0.2.0 — Early Preview

Fjord is a cross-platform, workspace-first Git desktop application. It groups
multiple local repositories into workspaces, summarizes which ones need
attention, and keeps detailed repository history, changes, and recovery tools in
the same application.

> **Early Preview:** v0.2 is intended for evaluation and everyday workflows
> where users retain normal Git backups and review safety prompts. It is not a
> stable-support promise.

## Supported platforms

- Windows 11 x64: NSIS installer.
- macOS 13 or newer: package for Intel and Apple Silicon.
- Ubuntu 22.04 or newer x64: AppImage.

Packages are not code-signed for v0.2: Windows SmartScreen and macOS
Gatekeeper will show an unknown-publisher warning on first run (Windows:
"More info" → "Run anyway"; macOS: allow the app under System Settings →
Privacy & Security, or run `xattr -cr` on it). This does not affect update
security — every update artifact is still cryptographically signed and
verified by the mandatory Tauri updater key regardless of platform signing.

Remote operations require an installed system Git; local repository reads
remain available when network access is unavailable.

## What is included

This release adds the daily-driver capabilities that v0.1 explicitly deferred:

- **Start a merge**, not just recover from one. Merge a local branch or a
  known remote-tracking branch into the current branch, with fast-forward,
  ordinary, and **squash merge** modes; typed conflict handling feeds the
  existing conflict banner and abort path; entry points are the branch tree,
  commit graph, and command palette.
- **Start a basic rebase.** Rebase the current branch onto a chosen target
  with a generation-aware preflight (consequence summary, blockers, dirty-tree
  stash), shared conflict/continue/skip/abort handling, and an explicit
  Cancel. The **interactive rebase editor** (reorder/reword/squash/fixup/drop)
  is still not included — see Important limitations.
- **Full remote CRUD.** Add, edit (URL and push URL), rename, and remove
  remotes, with orphaned-upstream-branch disclosure before removal. v0.1 only
  supported list/add.
- **Working Changes right-click menu.** Open, reveal in file manager, ignore
  (exact path / extension / directory, UTF-8-safe), delete, per-file stash,
  create a patch from unstaged or staged changes, copy patch to clipboard, and
  open in an external diff tool.
- **Multi-file selection and batch actions** in Working Changes: click/ctrl/
  shift selection with full keyboard and screen-reader support, batch
  stage/unstage, a selection-aware **Stash N files…**, and batch discard with
  the same all-or-nothing safety guarantee as a single-file discard, plus
  multi-file patch export.
- **Stash management**: a dedicated Stashes section in the repository tree,
  named/scoped stash creation (all changes or an exact file selection), a
  stash inspector with a bounded diff, stash markers in the commit graph, and
  Apply / Pop / Drop / Create branch from stash / Copy.
- **Workspace health and filtering.** An expected-branch setting per
  workspace with a "28 of 31 on develop" summary, a revised "needs attention"
  rule that no longer flags a merely dirty repository, and composable
  workspace filter chips (needs attention, dirty, ahead, behind, conflicts,
  wrong branch).

## Workspace-first workflow

Unlike a single-repository-first client, Fjord opens on a workspace overview.
Repositories remain independent on disk, while their branch, ahead/behind,
dirty, and conflict states are summarized together. Bulk actions are bounded and
report a result per repository; opening one repository reveals its full history
and working tree without losing the workspace context.

## Important limitations

- No GitHub/GitLab account integration, OAuth, provider-side repository
  creation, pull-request or issue management.
- No worktree management, interactive rebase editor, plugins, cloud sync, or
  team collaboration. Fjord can start and drive a basic (non-interactive)
  rebase to completion, but the step-list editor (reorder, reword, squash,
  fixup, drop) is not included.
- Linux is distributed as an AppImage; there is no signed apt/rpm repository.
- The updater plugin is packaged and signed metadata is produced, but v0.2
  does not perform background update checks or automatic installation.
- Performance evidence is fixture- and scenario-specific. v0.2 makes no claim
  that every very large or unusual repository will meet a universal latency or
  memory target.

## Safety expectations

Keep normal backups for valuable work. Fjord validates repository snapshots
before mutations, never stores Git credentials, uses installed system Git for
network transport, and presents consequence/recoverability facts before
destructive actions. Force is never implicit: force-with-lease requires its own
fresh confirmation bound to the observed remote state. Batch actions (multi-file
stage/unstage/discard) apply the same all-or-nothing token-bound preflight as
their single-file equivalents — a stale selection fails the whole batch rather
than applying part of it.

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

Download only artifacts attached to the `v0.2.0` GitHub Release once the release
pipeline (`.github/workflows/release.yml`) has published it: same-SHA CI green,
all three platform packages built and signed where configured, and
`packaging-verification` confirming `latest.json` and its signatures are
correctly attached before the release is flipped to public. Verify the
published filename and checksum evidence for your platform. Source-build
prerequisites and commands are in the root [`README.md`](../../README.md).
