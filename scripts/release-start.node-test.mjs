import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cleanupFixture, createReleaseFixture, git } from "./release-test-fixture.mjs";

const script = path.resolve("scripts/release-start.mjs");

function run(root, version) {
  return spawnSync(process.execPath, [script, version].filter((value) => value !== undefined), {
    cwd: root,
    encoding: "utf8",
  });
}

function currentBranch(root) {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

test("creates release/<version> from develop and prepares the version", () => {
  const root = createReleaseFixture({ version: "0.1.0", branch: "develop" });
  try {
    const result = run(root, "0.2.0");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(currentBranch(root), "release/0.2.0");

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(packageJson.version, "0.2.0");
  } finally {
    cleanupFixture(root);
  }
});

test("refuses to start outside of develop", () => {
  const root = createReleaseFixture({ version: "0.1.0", branch: "master" });
  try {
    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must run from "develop"/);
    assert.equal(currentBranch(root), "master");
  } finally {
    cleanupFixture(root);
  }
});

test("refuses when the release branch already exists locally", () => {
  const root = createReleaseFixture({ version: "0.1.0", branch: "develop" });
  try {
    git(root, ["branch", "release/0.2.0"]);

    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.equal(currentBranch(root), "develop");
  } finally {
    cleanupFixture(root);
  }
});

test("refuses a dirty working tree", () => {
  const root = createReleaseFixture({ version: "0.1.0", branch: "develop" });
  try {
    fs.writeFileSync(path.join(root, "untracked.txt"), "pending work\n");

    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.equal(currentBranch(root), "develop");
  } finally {
    cleanupFixture(root);
  }
});
