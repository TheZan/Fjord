# Contributing to Fjord

Thanks for taking the time to help Fjord. The project is still early, so small,
well-scoped changes are the easiest to review.

## Development setup

Prerequisites:

- Node.js 22 or newer.
- Rust stable.
- Platform dependencies required by Tauri v2. On Linux, install WebKitGTK and
  appindicator packages matching the CI workflow in `.github/workflows/ci.yml`.

Install dependencies and run the app:

```bash
npm ci
npm run tauri dev
```

Run the standard checks before opening a pull request:

```bash
npm run build
npm test
npm run check-i18n
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Picking work

- Use `docs/tasks.md` as the source of truth for planned work and stable task
  IDs.
- Reference the task ID in commits and pull request descriptions when a change
  maps to the board.
- Keep pull requests focused. Prefer one user-facing behavior change or one
  task-board item per PR.

## Architecture expectations

- Preserve the Clean Architecture dependency direction described in
  `docs/SDD.md`.
- Frontend IPC calls should go through `src/infrastructure/tauriClient.ts`.
- Rust command handlers should stay thin and delegate behavior to services.
- Do not shell out to `git` for hot-path Git operations; use the `GitBackend`
  port and the existing `fjord-git` adapter.

## Localization

Fjord ships English and Russian catalogs. When adding or changing user-visible
text:

- Add keys to the English and Russian catalogs.
- Keep Git vocabulary consistent with `src/locales/en/glossary.md`.
- Run `npm run check-i18n`.

## Security

Do not open public issues for vulnerabilities. Email the maintainer or use a
private security advisory if the repository enables GitHub Security Advisories.
Never commit credentials, signing keys, certificates, repository contents, or
diff bodies from private repositories.

## Release work

Release packaging and signing are documented in `docs/release.md`. The signing
certificates and updater private key live only in GitHub Secrets.
