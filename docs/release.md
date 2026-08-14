# Fjord release checklist

This checklist covers `docs/tasks.md` P3-03: cross-platform packaging,
code-signing, and the updater channel. For the human GitFlow procedure —
branching, exact commands, and what to do when something fails — see
[`releasing.md`](releasing.md); this document is the reference for the
packaging/signing/updater mechanics it drives.

## Versioning

`npm run release:prepare -- <version>` is the only supported way to bump
Fjord's version: it updates `Cargo.toml`'s `[workspace.package].version`,
`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, and
`Cargo.lock`'s workspace-member entries together, and creates a release-note
skeleton at `docs/releases/fjord-v<version>.md` if one doesn't exist yet.
`npm run release:verify` checks that all of those locations still agree (and,
given `--tag vX.Y.Z`, that the tag matches too) — the exact same check CI runs
before a release is allowed to build. See [`releasing.md`](releasing.md) for
the full `release:start`/`release:prepare`/`release:verify` workflow.

A release happens only when a human pushes an annotated tag `v<version>`. The
workflow parses that version from the tag, verifies it matches the project's
own version, and — once every check below passes — publishes a GitHub Release
named `Fjord v<version> — Early Preview`.

## Updater signing

Generate the updater key pair once:

```bash
npm run tauri signer generate -- -w ~/.tauri/fjord-updater.key
```

Do not commit either key. Save the public key in the repository secret
`TAURI_UPDATER_PUBKEY`, and save the private key contents in
`TAURI_SIGNING_PRIVATE_KEY`; if the key is password-protected, save the password
in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**Keep an offline backup of the private key** (a password manager entry or an
encrypted offline volume, outside GitHub) before you ever use it in CI. If it
is lost, there is no way to sign a future update that already-installed
Fjord clients will accept as coming from the same publisher — every existing
installation would need a fresh manual download instead of an in-place
update. GitHub Actions secrets are write-only: once set, GitHub itself cannot
show you the value back if your only copy is deleted.

CI release builds inject the updater configuration into
`src-tauri/tauri.conf.json`, enable the Cargo `updater` feature, and create
updater artifacts plus signatures. Local `npm run tauri build` packages omit the
updater plugin unless you explicitly provide the same configuration and build
with `--features updater`. The published update manifest endpoint is:

```text
https://github.com/TheZan/Fjord/releases/latest/download/latest.json
```

Fjord currently has one **Early Preview** channel for every version: the
release title stays `Fjord v<version> — Early Preview` regardless of whether
the version is `0.1.0` or `0.9.0`. Fjord registers the updater plugin in
signed release builds but performs only the runtime checks described in
[`releasing.md`](releasing.md) and the frontend's `application/update/`
module — no server-side channel routing exists yet. `latest.json` and its
signatures are required packaging evidence for every release. A stable/beta
channel is documented as a future extension point only (see "Future
channels" below), not implemented.

## Release pipeline

`.github/workflows/release.yml` fails closed in four jobs, generic for any
`vX.Y.Z` tag — see [`releasing.md`](releasing.md#what-happens-automatically-after-git-push-origin-vxyz)
for the full walkthrough:

1. `prerequisites` parses the version from the tag, requires it to match every
   project version location (`npm run release:verify`), requires populated
   release notes for that version, and requires a successful `CI` run for the
   same commit.
2. `publish` independently builds signed Windows NSIS, macOS app/DMG packages
   for both architectures, and a Linux AppImage, uploaded to a still-draft,
   still-prerelease GitHub Release. Every leg checks the versioned name,
   bundled `fjord-askpass`, and absence of fixture/`.env` content before it
   can succeed.
3. `packaging-verification` runs even after failures, checks the draft
   release's assets and updater manifest/signatures against the parsed
   version, and reports every blocker it finds.
4. `publish-release` runs only if every job above succeeded, and flips the
   release to published (`draft=false, prerelease=false`) — the step that
   makes it visible through GitHub's `/releases/latest/` endpoint, which the
   updater's `latest.json` URL depends on.

Nothing before `publish-release` changes repository visibility or makes
anything public; a failure at any earlier stage leaves the release as an
unpublished draft.

### Future channels (not implemented)

A later stable/beta/nightly split would extend this pipeline by: publishing
each channel's `latest.json` to a distinct path or query parameter the
updater can select by build configuration, gating `publish-release` per
channel on stricter quality gates (see
[`specs/release-hardening.md`](specs/release-hardening.md) §7's alpha/beta/
stable gate-severity model), and keeping exactly one GitHub Release per
channel that `/releases/latest/` resolves against. None of this exists today;
Fjord has one channel.

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

## First public launch checklist (v0.1.0 only)

This section is the one-time checklist that gated `v0.1.0` specifically — the
first time Fjord's repository and packages became public at all. It is
**not** part of `release.yml` and does not run again for `0.1.1`, `0.2.0`, or
any later release; those follow the generic [`releasing.md`](releasing.md)
procedure only. It is kept here because the evidence documents remain the
historical record of that launch decision and because a future `1.0.0` or
other major re-launch may warrant the same level of scrutiny again.

Complete the automated and platform-manual lifecycle in
[`v0.1-fresh-install-smoke.md`](v0.1-fresh-install-smoke.md) against the exact
candidate artifacts. Its evidence notes are required inputs to the public launch
gate; a developer checkout is not a substitute for the packaged pass.
Complete the publication-tree and GitHub-settings review in
[`public-readiness.md`](public-readiness.md); its external settings/default-branch
items remain human-owned.
Review [`v0.1-launch-decision.md`](v0.1-launch-decision.md) and update its
machine-readable [`v0.1-launch-evidence.json`](v0.1-launch-evidence.json) only
when the linked exact-candidate evidence exists. `npm run gate:v0.1` must emit
the ready decision and exit successfully before a human publishes or changes
repository visibility; a non-zero blocked result is the expected fail-closed
state while any evidence is absent. Run this and get it green before pushing
the `v0.1.0` tag — the generic `release.yml` pipeline does not check it.

Before publishing this specific first release:

- Run `npm run check:release-notes` and use
  [`releases/fjord-v0.1.0-early-preview.md`](releases/fjord-v0.1.0-early-preview.md)
  as the candidate release body. The check requires every platform, workflow,
  workspace-first, limitation, safety, reporting, and Early Preview section to
  be populated; compare its claims with the exact candidate and this checklist.
- Confirm every item in `docs/tasks.md` Phase 3 is closed or deliberately
  deferred in the release notes.
- Re-run the local verification commands above from a clean checkout.
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
- Confirm the app starts without terminal output or developer tooling on all
  supported OSes.

Complete all of the above, and get `npm run gate:v0.1` to print the ready
decision, **before** pushing the `v0.1.0` tag. Once pushed, `release.yml`
builds, verifies, and — if every automated check passes — publishes the
release on its own (see [`releasing.md`](releasing.md)); there is no separate
manual "publish" step to perform against the finished draft.
