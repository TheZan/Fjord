import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cleanupFixture, createReleaseFixture, git } from "./release-test-fixture.mjs";

const script = path.resolve("scripts/release-prepare.mjs");

function run(root, version) {
  return spawnSync(process.execPath, [script, version].filter((value) => value !== undefined), {
    cwd: root,
    encoding: "utf8",
  });
}

function versionOf(root, relativePath, pointer = "version") {
  const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  return pointer.split(".").reduce((current, key) => (key ? current?.[key] : current), value);
}

test("bumps every version location and creates a release-note skeleton", () => {
  const root = createReleaseFixture({ version: "0.1.0" });
  try {
    const result = run(root, "0.2.0");
    assert.equal(result.status, 0, result.stderr);

    assert.equal(versionOf(root, "package.json"), "0.2.0");
    assert.equal(versionOf(root, "package-lock.json"), "0.2.0");
    assert.equal(versionOf(root, "src-tauri/tauri.conf.json"), "0.2.0");

    const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
    assert.match(cargoToml, /version = "0\.2\.0"/);

    const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
    assert.doesNotMatch(cargoLock, /version = "0\.1\.0"/);

    const notesPath = path.join(root, "docs/releases/fjord-v0.2.0.md");
    assert.ok(fs.existsSync(notesPath), "expected a release-note skeleton to be created");
    assert.match(fs.readFileSync(notesPath, "utf8"), /# Fjord v0\.2\.0/);
  } finally {
    cleanupFixture(root);
  }
});

test("rejects an invalid SemVer version and changes nothing", () => {
  const root = createReleaseFixture({ version: "0.1.0" });
  try {
    const result = run(root, "0.2");
    assert.notEqual(result.status, 0);
    assert.equal(versionOf(root, "package.json"), "0.1.0");
  } finally {
    cleanupFixture(root);
  }
});

test("rejects a dirty working tree", () => {
  const root = createReleaseFixture({ version: "0.1.0" });
  try {
    fs.writeFileSync(path.join(root, "untracked.txt"), "pending work\n");

    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean working tree/);
    assert.equal(versionOf(root, "package.json"), "0.1.0");
  } finally {
    cleanupFixture(root);
  }
});

test("refuses to compound pre-existing version drift", () => {
  const root = createReleaseFixture({ version: "0.1.0", commit: false });
  try {
    const packageJsonPath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "0.1.1";
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));

    // Commit the drift itself so the tree is clean but already inconsistent.
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "drifted baseline"]);

    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pre-existing version inconsistencies/);
    assert.equal(versionOf(root, "src-tauri/tauri.conf.json"), "0.1.0");
  } finally {
    cleanupFixture(root);
  }
});

test("does not overwrite an existing release-note file for the target version", () => {
  const root = createReleaseFixture({ version: "0.1.0" });
  try {
    fs.mkdirSync(path.join(root, "docs/releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/releases/fjord-v0.2.0.md"), "custom pre-written notes\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "pre-written notes"]);

    const result = run(root, "0.2.0");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(root, "docs/releases/fjord-v0.2.0.md"), "utf8"),
      "custom pre-written notes\n",
    );
  } finally {
    cleanupFixture(root);
  }
});
