import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cleanupFixture, createReleaseFixture } from "./release-test-fixture.mjs";

const checker = path.resolve("scripts/release-verify.mjs");

function run(root, args = []) {
  return spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: "utf8" });
}

test("passes for coherent metadata with no tag given", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanupFixture(root);
  }
});

test("fails when package.json drifts from Cargo.toml", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    const packageJsonPath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "0.2.1";
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));

    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package\.json/);
  } finally {
    cleanupFixture(root);
  }
});

test("passes when --tag matches the project version", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    const result = run(root, ["--tag", "v0.2.0"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanupFixture(root);
  }
});

test("fails closed when the tag version does not match the project version", () => {
  const root = createReleaseFixture({ version: "0.2.0" });
  try {
    const result = run(root, ["--tag", "v0.3.0"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /v0\.3\.0/);
    assert.match(result.stderr, /0\.2\.0/);
  } finally {
    cleanupFixture(root);
  }
});
