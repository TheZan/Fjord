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

CI release builds inject the updater configuration into
`src-tauri/tauri.conf.json`, enable the Cargo `updater` feature, and create
updater artifacts plus signatures. Local `npm run tauri build` packages omit the
updater plugin unless you explicitly provide the same configuration and build
with `--features updater`. The published update manifest endpoint is:

```text
https://github.com/TheZan/Fjord/releases/latest/download/latest.json
```

For v0.1 there is one **Early Preview** channel: the workflow creates only a
draft GitHub prerelease from the exact `v0.1.0` tag. Fjord registers the updater
plugin in signed release builds but does not initiate background checks or
automatic installation, so v0.1 users are not silently moved between channels.
`latest.json` and its signatures are still required packaging evidence and must
describe the same candidate artifacts. A stable channel is not enabled.

## v0.1 packaging gate

`.github/workflows/release.yml` fails closed in three layers:

1. `prerequisites` requires coherent `0.1.0` versions, the exact `v0.1.0` tag,
   release-gate regression tests, and a successful `CI` run for the same SHA.
2. The platform matrix independently builds signed Windows NSIS, macOS app/DMG
   packages for both architectures, and a Linux AppImage. Every leg checks the
   versioned name, bundled `fjord-askpass`, and absence of fixture/`.env`
   content before it can succeed.
3. `eligibility` runs even after failures, requires the protected
   `v0.1-release-gate` environment, checks the draft/prerelease assets, updater
   manifest/signatures, and requires repository variables
   `V0_1_CLEAN_MACHINE_EVIDENCE` and `V0_1_FRESH_INSTALL_EVIDENCE`. It reports
   all discovered blockers and is green only when the candidate is eligible for
   the separate public launch review.

The evidence variables contain reviewable URLs, never a boolean assertion. The
release remains a draft, and no workflow changes repository visibility.

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

### Askpass sidecar

Every bundle must contain `fjord-askpass`. Build and prepare it before a manual
Tauri bundle:

```bash
cargo build --release -p fjord-askpass
npm run prepare:askpass
npm run tauri -- build --config src-tauri/tauri.sidecar.conf.json
```

For cross-target builds set `FJORD_SIDECAR_TARGET` to the Rust target triple.
The release workflow performs these steps per matrix target. Tauri's sidecar
config and the preparation script intentionally fail the build when the expected
target-specific binary is absent. CI also opens/scrutinizes each unsigned smoke
bundle and checks that the helper is present.

## Public release checklist

Complete the automated and platform-manual lifecycle in
[`v0.1-fresh-install-smoke.md`](v0.1-fresh-install-smoke.md) against the exact
candidate artifacts. Its evidence notes are required inputs to the public launch
gate; a developer checkout is not a substitute for the packaged pass.
Complete the publication-tree and GitHub-settings review in
[`public-readiness.md`](public-readiness.md); its external settings/default-branch
items remain human-owned.

Before publishing a draft release:

- Run `npm run check:release-notes` and use
  [`releases/fjord-v0.1.0-early-preview.md`](releases/fjord-v0.1.0-early-preview.md)
  as the candidate release body. The check requires every platform, workflow,
  workspace-first, limitation, safety, reporting, and Early Preview section to
  be populated; compare its claims with the exact candidate and this checklist.
- Confirm every item in `docs/tasks.md` Phase 3 is closed or deliberately
  deferred in the release notes.
- Re-run the local verification commands above from a clean checkout.
- Trigger the `Release` workflow and verify Windows, macOS, and Linux artifacts
  are attached to the draft GitHub Release.
- Install the generated artifacts on at least one machine per supported OS.
- Verify first-run onboarding, workspace creation, repository import, status
  refresh, branch checkout, fetch/pull/push, and external IDE launch.
- Verify Settings → Git diagnostics and connection test, then exercise HTTPS
  and SSH with saved credentials, first login/browser MFA, expired credentials,
  passphrase-protected keys, cancellation, proxy, and certificate failures.
- Record the manual compatibility result for GitHub, GitLab, Azure DevOps, and
  the supported self-hosted HTTPS/SSH environments before publishing.
- Verify the updater manifest (`latest.json`) is attached and every platform
  entry has a URL and signature.
- Confirm the release notes retain the known limitations, especially unsigned
  Linux package-repository status and unavailable distribution channels.
- Publish the release only after the app starts without terminal output or
  developer tooling on all supported OSes.
