import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cleanupFixture, createReleaseFixture, populatedReleaseNotes } from "./release-test-fixture.mjs";
import { renderSkeleton } from "./release-notes-lib.mjs";

const checker = path.resolve("scripts/check-release-notes.mjs");

function run(root, version) {
  return spawnSync(process.execPath, [checker, version].filter((value) => value !== undefined), {
    cwd: root,
    encoding: "utf8",
  });
}

test("fails when the release-note file does not exist", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/);
  } finally {
    cleanupFixture(root);
  }
});

test("fails on an unfilled release-prepare skeleton", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    fs.writeFileSync(path.join(root, "docs/releases/fjord-v0.2.0.md"), renderSkeleton("0.2.0"));

    const result = run(root, "0.2.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /placeholder/);
  } finally {
    cleanupFixture(root);
  }
});

test("passes for fully populated release notes", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    fs.writeFileSync(path.join(root, "docs/releases/fjord-v0.2.0.md"), populatedReleaseNotes("0.2.0"));

    const result = run(root, "0.2.0");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanupFixture(root);
  }
});

test("defaults to the project's own version when none is given", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    fs.writeFileSync(path.join(root, "docs/releases/fjord-v0.2.0.md"), populatedReleaseNotes("0.2.0"));

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanupFixture(root);
  }
});

test("falls back to the legacy -early-preview filename", () => {
  const root = createReleaseFixture({ version: "0.1.0" });
  try {
    fs.writeFileSync(
      path.join(root, "docs/releases/fjord-v0.1.0-early-preview.md"),
      populatedReleaseNotes("0.1.0"),
    );

    const result = run(root, "0.1.0");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanupFixture(root);
  }
});
