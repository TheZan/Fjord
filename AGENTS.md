# Fjord agent guide

## Start here

- Read `docs/tasks.md` for the ordered task board and stable task IDs.
- Read the relevant section of `docs/SDD.md` and the matching file in
  `docs/specs/` before changing a product contract or architecture.
- Keep changes scoped to the requested task. Do not start a future roadmap phase
  merely because its design already exists.

## Repository map

- `src/` — React/TypeScript frontend.
- `src-tauri/` — thin Tauri entrypoint.
- `crates/fjord-domain/` — shared domain types.
- `crates/fjord-ports/` — ports and stable backend errors.
- `crates/fjord-services/` — application use cases.
- `crates/fjord-git/`, `crates/fjord-db/`, `crates/fjord-fs/` — adapters.
- `crates/fjord-app/` — Tauri composition, commands, runtime state.
- `docs/specs/` — normative subsystem contracts; `docs/benchmarks/` — measurements.

## Architecture rules

- Preserve dependency direction: domain → ports → services → adapters/app.
  Command handlers are thin adapters; put behavior in services or the appropriate
  infrastructure crate.
- Add or change frontend/backend IPC only through
  `src/infrastructure/tauriClient.ts`, registered Tauri commands, and
  `docs/specs/ipc-commands.md`. Run `npm run check-ipc-docs`.
- Use `GitBackend` for local repository behavior and `GitRemoteBackend` for all
  network transport. Do not add libgit2 remote callbacks, credential storage, or
  direct frontend calls to Tauri's generic `invoke`.
- Preserve generation-scoped invalidation, snapshot validation, and repository
  tiering. A repository mutation or network operation must validate the current
  snapshot before its operation task is created.
- Keep Cold repository work bounded. Do not restore recursive worktree watchers
  for every repository without measurement evidence.

## Frontend rules

- Put user-visible strings in all locale catalogs and keep Git vocabulary aligned
  with `src/locales/en/glossary.md`.
- Preserve keyboard navigation, focus behavior, ARIA labels, and accessible
  disabled reasons when changing UI controls.
- Reuse the shared UI and shell components rather than creating parallel owners
  for global controls or query state.

## Security and privacy

- Never log or commit credentials, askpass values, prompt answers, private
  repository contents, diff bodies, signing keys, or URLs containing userinfo.
- Keep diagnostic output sanitized and bounded. Remote operations use the user's
  installed system Git and existing credential helpers/SSH configuration.

## Verification

Run the checks affected by the change; run the full set for cross-cutting work:

```powershell
npm run build
npm test
npm run check-i18n
npm run check-ipc-docs
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`CI` runs the frontend checks once and Rust tests on Windows, macOS, and Linux.
Do not claim GitHub Actions passed unless its result is available.

## Documentation and Git

- If implementation changes a contract, task state, roadmap dependency, or
  current-state claim, update the corresponding SDD/spec/task-board text in the
  same change. Keep historical benchmark numbers labelled as historical.
- Use focused commits with an imperative subject. Do not rewrite unrelated user
  changes or use destructive Git commands without explicit approval.
