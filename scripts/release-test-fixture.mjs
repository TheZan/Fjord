// Test-only fixture builder shared by release-verify/-prepare/-start and
// check-release-notes node:test suites — one minimal, valid, git-backed
// "Fjord repo" scaffold instead of four copies of the same boilerplate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function cargoLockFixture(version) {
  return [
    "[[package]]",
    'name = "fjord"',
    `version = "${version}"`,
    "dependencies = [",
    "]",
    "",
    "[[package]]",
    'name = "fjord-app"',
    `version = "${version}"`,
    "dependencies = [",
    "]",
    "",
  ].join("\n");
}

/**
 * @param {object} [options]
 * @param {string} [options.version]
 * @param {string} [options.branch]
 * @param {boolean} [options.commit] commit the baseline so `git status --porcelain` is clean
 */
export function createReleaseFixture({ version = "0.1.0", branch = "develop", commit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-release-fixture-"));

  git(root, ["init", "-q", "-b", branch]);
  git(root, ["config", "user.email", "fjord-test@example.com"]);
  git(root, ["config", "user.name", "Fjord Release Test"]);

  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fjord", private: true, version }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(
      { name: "fjord", version, lockfileVersion: 3, requires: true, packages: { "": { name: "fjord", version } } },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    `[workspace]\nmembers = ["src-tauri"]\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n`,
  );
  fs.writeFileSync(path.join(root, "Cargo.lock"), cargoLockFixture(version));
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    `${JSON.stringify(
      {
        productName: "Fjord",
        version,
        build: { frontendDist: "../dist" },
        app: { windows: [{}] },
        bundle: {},
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.sidecar.conf.json"),
    `${JSON.stringify({ bundle: { externalBin: ["binaries/fjord-askpass"] } }, null, 2)}\n`,
  );

  if (commit) {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fixture baseline"]);
  }

  return root;
}

export function cleanupFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function populatedReleaseNotes(version) {
  return `# Fjord v${version} — Early Preview

Fjord is a cross-platform, workspace-first Git desktop application.

> **Early Preview:** intended for evaluation and everyday workflows.

## Supported platforms

- Windows 11 x64: signed NSIS installer.
- macOS 13 or newer: signed and notarized package.
- Ubuntu 22.04 or newer x64: AppImage.

Remote operations require an installed system Git.

## What is included

This release adds workspace-first repository management and bulk operations
across every tracked repository in a workspace.

## Workspace-first workflow

Repositories remain independent on disk while Fjord summarizes their branch
and status together in one workspace overview.

## Important limitations

No OAuth account integration and no interactive rebase editor are included in
this release.

## Safety expectations

Keep normal backups. Fjord validates repository snapshots before mutations
and never stores Git credentials.

## Reporting bugs and security issues

Use the bug report form for reproducible non-security problems.

Report vulnerabilities privately through the security advisory form at
https://github.com/TheZan/Fjord/security/advisories/new as described in
SECURITY.md.

## Installation and verification

Download only artifacts attached to the v${version} GitHub Release after its
release checks pass.
`;
}
