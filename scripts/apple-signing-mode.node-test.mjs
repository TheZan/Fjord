import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/apple-signing-mode.mjs");

const FULL_ENV = {
  APPLE_CERTIFICATE: "base64-cert",
  APPLE_CERTIFICATE_PASSWORD: "cert-password",
  APPLE_ID: "dev@example.com",
  APPLE_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "ABCDE12345",
};

function run(extraEnv) {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fjord-apple-signing-")), "github_output");
  fs.writeFileSync(outputPath, "");
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputPath, ...extraEnv },
  });
  const output = fs.readFileSync(outputPath, "utf8");
  fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  return { ...result, output };
}

test("no secrets -> exits 0, writes mode=unsigned", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^mode=unsigned$/m);
  assert.match(result.stdout, /::notice::/);
});

test("complete secrets -> exits 0, writes mode=signed", () => {
  const result = run(FULL_ENV);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^mode=signed$/m);
});

test("partial secrets -> exits non-zero, writes nothing to GITHUB_OUTPUT", () => {
  const { APPLE_TEAM_ID, ...partial } = FULL_ENV;
  void APPLE_TEAM_ID;
  const result = run(partial);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::/);
  assert.equal(result.output, "");
});
