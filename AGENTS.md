# Fjord agent guide

Fjord is a Tauri v2 desktop Git client: a React/TypeScript frontend over a Rust
workspace. This file is read by Codex and by Claude Code (no `CLAUDE.md` is needed).

## Start here

- Read `docs/tasks.md` for the ordered task board and stable task IDs.
- Read the relevant section of `docs/SDD.md` and the matching file in
  `docs/specs/` before changing a product contract or architecture.
- Keep changes scoped to the requested task. Do not start a future roadmap phase
  merely because its design already exists.

## Repository map

- `src/` — React/TypeScript frontend (`application/`, `domain/`,
  `infrastructure/`, `presentation/`, `locales/`; Vitest tests sit next to code).
- `src-tauri/` — thin Tauri entrypoint.
- `crates/fjord-domain/` — shared domain types.
- `crates/fjord-ports/` — ports and stable backend errors.
- `crates/fjord-services/` — application use cases.
- `crates/fjord-git/`, `crates/fjord-db/`, `crates/fjord-fs/` — adapters.
  Most Git behavior tests live in `crates/fjord-git/src/local/tests.rs`.
- `crates/fjord-app/` — Tauri composition, commands, runtime state.
- `crates/fjord-askpass/` — askpass sidecar; `crates/fjord-bench/` — benchmarks.
- `e2e/` — Playwright specs; `scripts/` — i18n/IPC checks and release tooling.
- `docs/specs/` — normative subsystem contracts; `docs/benchmarks/` — measurements.

## Architecture rules

- Preserve dependency direction: domain → ports → services → adapters/app.
  Command handlers are thin adapters; put behavior in services or the appropriate
  infrastructure crate.
- Add or change frontend/backend IPC only through
  `src/infrastructure/tauriClient.ts`, registered Tauri commands, and
  `docs/specs/ipc-commands.md`. Run `npm run check-ipc-docs`.
- Use `GitBackend` for local repository behavior and `GitRemoteBackend` for all
  network transport. Do not shell out to `git` for hot-path local reads. Do not
  add libgit2 remote callbacks, credential storage, or direct frontend calls to
  Tauri's generic `invoke`.
- Preserve generation-scoped invalidation, snapshot validation, and repository
  tiering. A repository mutation or network operation must validate the current
  snapshot before its operation task is created.
- Keep Cold repository work bounded. Do not restore recursive worktree watchers
  for every repository without measurement evidence.

## Frontend rules

- Put user-visible strings in every locale catalog (en, ru, de, fr, es) and keep
  Git vocabulary aligned with `src/locales/en/glossary.md`.
- Preserve keyboard navigation, focus behavior, ARIA labels, and accessible
  disabled reasons when changing UI controls.
- Reuse the shared UI and shell components rather than creating parallel owners
  for global controls or query state.

## Security and privacy

- Never log or commit credentials, askpass values, prompt answers, private
  repository contents, diff bodies, signing keys, or URLs containing userinfo.
- Keep diagnostic output sanitized and bounded. Remote operations use the user's
  installed system Git and existing credential helpers/SSH configuration.

## Environment

- CI uses Node.js 22 and Rust stable. Run `npm ci` after `package-lock.json`
  changes; a stale `node_modules` fails `npm run build` with
  "Cannot find module '@playwright/test'".
- Node.js 25+ ships its own `localStorage`, which hides jsdom's and fails the
  `localStorage.clear()` tests in `uiState.test.ts` and
  `ResizableRepoLayout.test.tsx`. On such a Node run Vitest with
  `NODE_OPTIONS=--no-experimental-webstorage`; Node 22 needs nothing.
- Sandboxed agents (for example Codex workspace-write on Windows) cannot pass
  `libgit2_ownership_refusal_has_a_typed_error`, and
  `rebase_failed_hook_retains_explicit_stash_and_reports_its_actual_selector`
  can hang there. Run narrow filters inside a sandbox and the full Rust suite
  outside it; report a check that could not run instead of retrying it.

## Verification

Use the smallest check that covers the change, then widen it for cross-cutting
work. Times are from a warm cache on an Apple Silicon Mac (2026-10-07).

| Change | Command | Time |
| --- | --- | --- |
| One frontend module | `npx vitest run <path>` | ~2 s |
| Frontend types and bundle | `npm run build` (tsc + Vite) | ~3 s |
| All frontend unit tests | `npm test` | ~8 s |
| User-visible strings | `npm run check-i18n` | <1 s |
| IPC commands or `tauriClient.ts` | `npm run check-ipc-docs` | <1 s |
| One Rust crate or area | `cargo test -p <crate> [name-filter]`, e.g. `cargo test -p fjord-git rebase` | 2–18 s |
| Rust formatting | `cargo fmt --all --check` | <1 s |
| Rust lints | `cargo clippy --workspace --all-targets -- -D warnings` | ~12 s |
| All Rust tests | `cargo test --workspace` | ~40 s |
| Rebase/merge UI flows | `npm run test:e2e` (builds, then Playwright) | needs `npx playwright install chromium` first |
| Release scripts in `scripts/` | the matching `npm run test:release-*`, `test:apple-signing`, `test:updater-manifest`, `test:launch-gate` | seconds |

Full set before handing over cross-cutting work:

```sh
npm run build && npm test && npm run check-i18n && npm run check-ipc-docs
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

CI (`.github/workflows/ci.yml`) also runs e2e, `audit:public` and the release
script tests, and runs Rust tests on Windows, macOS and Linux. Do not claim
GitHub Actions passed unless its result is available.

## Documentation and Git

- If implementation changes a contract, task state, roadmap dependency, or
  current-state claim, update the corresponding SDD/spec/task-board text in the
  same change. Keep historical benchmark numbers labelled as historical.
- Feature branches (`feature/*`) start from and merge into `develop`; `master`
  holds released state (see `docs/releasing.md`). Use focused commits with an
  imperative subject and the task ID from `docs/tasks.md` when the change maps
  to the board.
- Do not rewrite unrelated user changes or use destructive Git commands without
  explicit approval.
