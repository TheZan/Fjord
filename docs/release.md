# Fjord release checklist

This checklist covers `docs/tasks.md` P3-03: cross-platform packaging,
code-signing, and the updater channel.

## Versioning

- Update the version in `package.json`, `src-tauri/tauri.conf.json`, and the
  Cargo workspace package version together.
- Create a tag named `v<version>` or run the `Release` workflow manually.
- The workflow creates a draft GitHub Release named `Fjord v<version>`.

## Updater signing

Generate the updater key pair once:

```bash
npm run tauri signer generate -- -w ~/.tauri/fjord-updater.key
```

Do not commit either key. Save the public key in the repository secret
`TAURI_UPDATER_PUBKEY`, and save the private key contents in
`TAURI_SIGNING_PRIVATE_KEY`; if the key is password-protected, save the password
in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Release builds inject the updater configuration into `src-tauri/tauri.conf.json`
at CI time and create updater artifacts plus signatures. The published update
manifest endpoint is:

```text
https://github.com/TheZan/Fjord/releases/latest/download/latest.json
```

## Platform signing secrets

Windows releases require:

- `WINDOWS_CERTIFICATE`: base64-encoded PFX signing certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password.
- optional repository variable `WINDOWS_TIMESTAMP_URL`; defaults to
  `http://timestamp.digicert.com`.

macOS releases require:

- `APPLE_CERTIFICATE`: base64-encoded Apple Developer ID Application
  certificate.
- `APPLE_CERTIFICATE_PASSWORD`: certificate password.
- `APPLE_SIGNING_IDENTITY`: signing identity name, when the certificate cannot
  be inferred.
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`: notarization credentials.

Linux packages are not code-signed by Tauri itself. The workflow still produces
signed updater artifacts; distribution-channel signing for `.deb`/`.rpm`
repositories should be added when Fjord has an external package repository.

## Local verification

Before cutting a release:

```bash
npm ci
npm run build
npm test
npm run check-i18n
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The release workflow repeats the packaging step on Windows, macOS, and Linux.

## Public release checklist

Before publishing a draft release:

- Confirm every item in `docs/tasks.md` Phase 3 is closed or deliberately
  deferred in the release notes.
- Re-run the local verification commands above from a clean checkout.
- Trigger the `Release` workflow and verify Windows, macOS, and Linux artifacts
  are attached to the draft GitHub Release.
- Install the generated artifacts on at least one machine per supported OS.
- Verify first-run onboarding, workspace creation, repository import, status
  refresh, branch checkout, fetch/pull/push, and external IDE launch.
- Verify the updater manifest (`latest.json`) is attached and every platform
  entry has a URL and signature.
- Write release notes with known limitations, especially unsigned Linux package
  repository status and any unavailable distribution channels.
- Publish the release only after the app starts without terminal output or
  developer tooling on all supported OSes.
