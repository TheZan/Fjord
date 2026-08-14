<p align="center">
  <img src="assets/logo/fjord-mark-teal.svg" alt="" width="72" height="72">
</p>

<h1 align="center">Fjord</h1>
<p align="center">A Git workspace manager, not just another Git client.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational">
  <img alt="Status" src="https://img.shields.io/badge/status-v0.1%20Early%20Preview-orange">
  <img alt="Rust" src="https://img.shields.io/badge/backend-Rust-b7410e">
  <img alt="TypeScript" src="https://img.shields.io/badge/frontend-TypeScript-3178c6">
</p>

---

> [!WARNING]
> **Fjord v0.1 is an Early Preview.** Use ordinary Git backups and review every
> destructive confirmation. Packaging and clean-machine evidence must pass the
> release gate before public binaries are published.

## Download and install

Fjord targets **Windows 11 x64**, **macOS 13+** (Intel and Apple Silicon), and
**Ubuntu 22.04+ x64**. Candidate installers are published only after the
fail-closed release checklist passes; use the
[GitHub Releases page](https://github.com/TheZan/Fjord/releases) for the signed
Windows installer, notarized macOS package, and Linux AppImage. There is no
automatic update installation in v0.1.

To build from source, install Node.js 22+, stable Rust, system Git, and the
[Tauri v2 platform prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
npm ci
npm run tauri dev
```

![Fjord workspace overview with repository status cards](assets/screenshots/fjord-workspace-overview.png)

_Workspace overview rendered from the shipped UI with seeded local demo data;
no private repository data is shown._

Most Git GUIs assume you're staring at one repository. In practice, a working day spans a handful of them — a backend service, a frontend app, some infrastructure config — and "what's the state of everything I'm touching right now" is a question no single-repo tool answers well.

Fjord starts from the workspace, not the repository. Group your repositories the way you actually think about your projects, see the state of all of them on one screen, and drop into any single one for a full branch and commit history when you need the detail.

## Features

- **Workspaces** — group repositories the way you work, not the way they happen to sit on disk.
- **Unified dashboard** — branch, ahead/behind, dirty and conflict status for every repository in a workspace, at a glance.
- **Bulk operations** — fetch, pull, or open a whole workspace in your IDE in one action, running concurrently.
- **Full single-repo view** — branches, a real commit graph with merge and branch topology, diffs, and a commit inspector.
- **Command palette** (⌘K / Ctrl+K) and global search across repositories, branches, and commits.
- **Bounded repository work** — status/history caches, paged history and diffs,
  and measured fixture benchmarks keep expensive reads off the render path.
- **Light, dark, or system theme.**
- **English, Russian, German, French, and Spanish**, switchable at runtime.
- **Native and cross-platform** — one fast, quiet app on Windows, macOS, and Linux.

## Git and authentication

Fjord uses the installed system Git for fetch, pull's network phase, push, and
remote branch operations. This preserves your existing Git Credential Manager,
credential helpers, SSH agent/config, proxy, and certificate setup. Fjord never
stores passwords, tokens, or private keys. If Git or SSH still needs input, the
bundled one-shot askpass helper shows a native Fjord prompt for that operation.

Open **Settings → Git** to see the executable/version and credential environment,
select a different Git binary, or run a read-only connection test.

### Troubleshooting remote operations

- **Git not found:** install Git or select its executable in Settings → Git.
- **Authentication failed / no credential helper:** configure the provider's
  recommended credential helper (for example Git Credential Manager), then use
  the connection test. Fjord does not accept or save a PAT in Settings.
- **SSH key not found:** verify `ssh-add -l`, `SSH_AUTH_SOCK`, and `~/.ssh/config`.
- **Host key verification failed:** connect with `ssh` in a terminal and verify
  the server fingerprint before accepting it; Fjord never bypasses host checks.
- **Certificate or proxy error:** fix the system Git `http.ssl*`/`http.proxy`
  configuration or corporate trust store. Fjord does not change global config.
- **More detail:** expand **Raw diagnostics** after a failed connection test.
  Application logs are stored in the platform app-data directory under `logs`;
  diagnostics are bounded and credentials are redacted.

## Tech stack

| | |
|---|---|
| **Desktop shell** | [Tauri v2](https://tauri.app/) — native webview, not Electron |
| **Backend** | Rust, [Tokio](https://tokio.rs/) |
| **Git engine** | [`gix`](https://github.com/GitoxideLabs/gitoxide) for local reads, [`git2`](https://github.com/rust-lang/git2-rs) for local mutations, system Git for all network transport |
| **Persistence** | SQLite via [`sqlx`](https://github.com/launchbadge/sqlx) |
| **Frontend** | React, TypeScript, [Vite](https://vitejs.dev/) |
| **UI** | Tailwind CSS v4, custom component primitives |
| **Data layer** | Typed Tauri IPC client + [TanStack Query](https://tanstack.com/query) |
| **Localization** | react-i18next |

## Early Preview scope

The v0.1 candidate includes workspace/repository onboarding, clone/create,
status and history, staged/unstaged and partial-hunk workflows, commit/amend,
branch/tag/stash operations, fetch/pull/push, explicit **Push & Set Upstream**,
and explicit current-branch push to several selected remotes without changing
upstream, plus operation-state controls, destructive preflights, and
reflog-based Recovery Center. Safety-sensitive network operations use the
installed system Git.

Not yet included: hosting-provider accounts/OAuth, provider-side repository
creation, pull requests/issues, full remote CRUD, worktrees, interactive rebase,
plugins, cloud sync, or team collaboration.

Phase goals and dependencies live in [`docs/SDD.md`](docs/SDD.md) §15; detailed task-level status in [`docs/tasks.md`](docs/tasks.md); per-subsystem contracts in [`docs/specs/`](docs/specs/).

## Contributing

Fjord is early, but contributions and issue reports are welcome when they are small and focused. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local setup, checks, and how to pick up work from the task board.

Report reproducible bugs with the GitHub issue templates. Report
vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md); never
attach credentials, private repository contents, or full diffs to a public issue.

## License

Fjord is dual-licensed under either of:

- MIT license ([LICENSE-MIT](LICENSE-MIT))
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))

at your option.
