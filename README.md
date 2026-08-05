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
  <img alt="Status" src="https://img.shields.io/badge/status-early%20development-orange">
  <img alt="Rust" src="https://img.shields.io/badge/backend-Rust-b7410e">
  <img alt="TypeScript" src="https://img.shields.io/badge/frontend-TypeScript-3178c6">
</p>

---

Most Git GUIs assume you're staring at one repository. In practice, a working day spans a handful of them — a backend service, a frontend app, some infrastructure config — and "what's the state of everything I'm touching right now" is a question no single-repo tool answers well.

Fjord starts from the workspace, not the repository. Group your repositories the way you actually think about your projects, see the state of all of them on one screen, and drop into any single one for a full branch and commit history when you need the detail.

## Features

- **Workspaces** — group repositories the way you work, not the way they happen to sit on disk.
- **Unified dashboard** — branch, ahead/behind, dirty and conflict status for every repository in a workspace, at a glance.
- **Bulk operations** — fetch, pull, or open a whole workspace in your IDE in one action, running concurrently.
- **Full single-repo view** — branches, a real commit graph with merge and branch topology, diffs, and a commit inspector.
- **Command palette** (⌘K / Ctrl+K) and global search across repositories, branches, and commits.
- **Fast on large repositories** — status and history are cached and updated incrementally, not recomputed on every screen.
- **Light, dark, or system theme.**
- **English and Russian out of the box**, switchable at runtime — more languages coming.
- **Native and cross-platform** — one fast, quiet app on Windows, macOS, and Linux.

## Tech stack

| | |
|---|---|
| **Desktop shell** | [Tauri v2](https://tauri.app/) — native webview, not Electron |
| **Backend** | Rust, [Tokio](https://tokio.rs/) |
| **Git engine** | [`gix`](https://github.com/GitoxideLabs/gitoxide) (gitoxide) with [`git2`](https://github.com/rust-lang/git2-rs) as fallback |
| **Persistence** | SQLite via [`sqlx`](https://github.com/launchbadge/sqlx) |
| **Frontend** | React, TypeScript, [Vite](https://vitejs.dev/) |
| **UI** | Tailwind CSS v4, custom component primitives |
| **Data layer** | Typed Tauri IPC client (migration to [TanStack Query](https://tanstack.com/query) planned) |
| **Localization** | react-i18next |

## Roadmap

- [x] Project scaffold: desktop shell boots, theming and localization wired end-to-end
- [x] Single-repo view: branches, commit graph, diffs
- [x] Workspaces: multi-repo grouping, live status, bulk operations, dashboard
- [x] Command palette, global search
- [ ] Cross-platform packaging and first public release

Detailed task-level status lives in [`docs/tasks.md`](docs/tasks.md); architecture and current-state notes in [`docs/SDD.md`](docs/SDD.md).

## Contributing

Fjord isn't taking external contributions yet — the foundations are still being built. Once there's a working skeleton, this section will cover setup and how to pick up an issue. Star or watch the repository if you'd like to be around for that.

## License

Fjord is dual-licensed under either of:

- MIT license ([LICENSE-MIT](LICENSE-MIT))
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))

at your option.
