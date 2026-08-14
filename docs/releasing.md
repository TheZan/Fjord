# Releasing Fjord

This is the step-by-step GitFlow procedure for cutting a Fjord release. For
packaging, signing, and updater mechanics (what `.github/workflows/release.yml`
actually does, and the full secrets/variables table), see
[`release.md`](release.md). This document is the human procedure; that one is
the reference for the machinery.

## Branching model

- `master` — released, production-ready state. Every commit on `master` is
  either already tagged or about to be.
- `develop` — active development. Feature branches merge here.
- `feature/*` — features, merged into `develop`.
- `release/X.Y.Z` — stabilizes a specific version before it ships. May contain
  only version metadata, release notes, packaging fixes, and release-specific
  bug fixes — no new features.
- `hotfix/X.Y.Z` — a fix for a production bug, branched from `master` so it
  doesn't have to wait for whatever `develop` currently contains.

A release happens only when a human pushes an annotated tag `vX.Y.Z`. Nothing
in this repository pushes, merges, or tags on its own — see
[Part 21 of the implementation constraints below](#what-never-happens-automatically).

## Versioning rules

Fjord uses SemVer (`MAJOR.MINOR.PATCH`), pre-1.0, with no alpha/beta/rc
suffixes:

- **PATCH** — bug fixes and small safe improvements (`0.1.0` → `0.1.1`).
- **MINOR** — meaningful new user-facing functionality (`0.1.x` → `0.2.0`).
- **MAJOR** — reserved for stable/post-1.0 compatibility-breaking changes.

"Early Preview" is a product label in the release title, not part of the
version: `Fjord v0.2.0 — Early Preview` is version `0.2.0`.

## Normal release

From a clean `develop`:

```bash
git checkout develop
git pull

git checkout -b release/0.2.0
npm run release:prepare -- 0.2.0
```

`release:prepare` bumps every canonical version location (`Cargo.toml`,
`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`Cargo.lock`'s workspace-member entries), and creates
`docs/releases/fjord-v0.2.0.md` from a skeleton if it doesn't already exist.

Fill in the release notes skeleton — `check:release-notes` deliberately fails
on the unfilled placeholders it contains, so this step can't be silently
skipped — then commit and push the release branch for review:

```bash
npm run check:release-notes
git add .
git commit -m "chore(release): v0.2.0"
git push -u origin release/0.2.0
```

Stabilize on this branch: only version metadata, release notes, packaging
fixes, and release-specific bug fixes belong here. Once it's ready:

```bash
git checkout master
git pull
git merge --no-ff release/0.2.0
git push origin master

git checkout develop
git pull
git merge --no-ff release/0.2.0
git push origin develop

git branch -d release/0.2.0
git push origin --delete release/0.2.0
```

Tag the released `master` commit — this is the intentional human action that
triggers everything else:

```bash
git checkout master
git pull
git tag -a v0.2.0 -m "Fjord v0.2.0"
git push origin v0.2.0
```

## Hotfix release

A critical bug is found in production (`v0.2.0`), while `develop` already has
unfinished `0.3` work. Branch from `master`, not `develop`:

```bash
git checkout master
git pull
git checkout -b hotfix/0.2.1

# ... fix the bug ...

npm run release:prepare -- 0.2.1
npm run check:release-notes
git add .
git commit -m "fix: <what broke>"
git commit -m "chore(release): v0.2.1"
git push -u origin hotfix/0.2.1
```

After review, merge into both `master` and `develop`, exactly like a normal
release branch, then tag `master`:

```bash
git checkout master
git merge --no-ff hotfix/0.2.1
git push origin master

git checkout develop
git merge --no-ff hotfix/0.2.1
git push origin develop

git branch -d hotfix/0.2.1
git push origin --delete hotfix/0.2.1

git checkout master
git tag -a v0.2.1 -m "Fjord v0.2.1"
git push origin v0.2.1
```

The release pipeline doesn't care whether a tag came from a `release/*` or
`hotfix/*` branch — the tag and the tagged commit's tree are the only source
of truth.

## What happens automatically after `git push origin vX.Y.Z`

`.github/workflows/release.yml` runs four jobs in order:

1. **`prerequisites`** — parses `VERSION` from the tag, runs
   `node scripts/release-verify.mjs --tag vX.Y.Z` (fails closed if any version
   location disagrees, or if the tag doesn't match the project version — e.g.
   tag `v0.3.0` against project version `0.2.0` fails the release), checks the
   matching `docs/releases/fjord-vX.Y.Z.md` is populated, and requires a
   successful `CI` run on the exact same commit.
2. **`publish`** — a matrix builds, signs, and packages Windows (NSIS), macOS
   (app + DMG, Intel and Apple Silicon), and Linux (AppImage), each verified
   for the `fjord-askpass` sidecar and the absence of fixture/`.env` content,
   and uploads everything to a still-**draft**, still-**prerelease** GitHub
   Release — nothing is public yet.
3. **`packaging-verification`** — checks every expected asset (all three
   platform packages, `latest.json`, and `.sig` signature files) is actually
   attached, and reports every blocker it finds.
4. **`publish-release`** — only if every job above succeeded, flips the
   release to published (`draft=false, prerelease=false`). This is the step
   that makes the release visible through GitHub's `/releases/latest/`
   endpoint, which is what the Tauri updater's `latest.json` URL depends on —
   a draft or prerelease release is invisible to it.

Releasing a routine patch or minor version after this point requires no
further manual work beyond the branch/merge/tag steps above.

## Required secrets and variables

See [`release.md`](release.md#platform-signing-secrets) for the complete list
of GitHub Actions secrets and variables the `publish` job requires
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_UPDATER_PUBKEY`, `WINDOWS_CERTIFICATE*`,
`APPLE_*`, and so on) and what happens when one is missing (the job fails
closed with a clear error, never a silently-unsigned build).

**Keep an offline backup of the updater signing private key** (the value in
`TAURI_SIGNING_PRIVATE_KEY`, generated with `npm run tauri signer generate`)
somewhere outside GitHub — a password manager or an encrypted offline volume.
If it's lost, there is no way to sign a future update that existing Fjord
installations will accept; they would all need to be manually reinstalled from
a fresh download instead of updating in place.

## If the release workflow fails

- **`prerequisites` fails** — either version metadata is inconsistent (run
  `npm run release:verify` locally to see exactly which file disagrees), the
  release notes have an unfilled section, or same-SHA CI hasn't gone green
  yet. Fix on `develop`/the release branch, or wait for CI; nothing was
  published.
- **`publish` fails on one platform leg** — the release stays a draft.
  Nothing is public. Fix the underlying issue and push a new commit to the
  same tagged commit's branch, then re-tag is *not* the fix — see below.
- **`packaging-verification` fails** — same as above: the release stays a
  draft, `publish-release` never runs, nothing is public.

## What must never be done

- **Never recreate a tag to point at different code.** If `v0.2.0` was pushed
  against the wrong commit, delete the (still-draft, if it never reached
  `publish-release`) GitHub Release, delete the tag, fix the code, and push a
  new tag — `v0.2.1` if the broken tag was ever visible to anyone, a
  re-pushed `v0.2.0` only if it's certain nothing public ever saw it. Moving
  an already-published tag is a supply-chain integrity break: existing
  installs' updater trusts the tag as a fixed point.
- **Never disable updater signature verification** to work around a signing
  problem — fix the signing secrets instead.
- **Never manually flip a release to published** if `packaging-verification`
  reported a blocker.

## The v0.1 first-launch checklist

`v0.1.0` was Fjord's first-ever public release, and carried extra one-time
verification that later patch releases don't need: a clean-machine
fresh-install pass on all three OSes, a full-history secrets audit, and human
sign-off on the public GitHub repository metadata. That checklist
([`v0.1-launch-decision.md`](v0.1-launch-decision.md),
[`v0.1-launch-evidence.json`](v0.1-launch-evidence.json),
[`public-readiness.md`](public-readiness.md),
[`v0.1-fresh-install-smoke.md`](v0.1-fresh-install-smoke.md)) is **not** part
of `release.yml` — it never gated `0.1.x` patches, let alone `0.2.0` and
beyond. Run `npm run gate:v0.1` by hand and get it to print the ready
decision before pushing the `v0.1.0` tag specifically; every other release
relies only on the generic gates described above.
