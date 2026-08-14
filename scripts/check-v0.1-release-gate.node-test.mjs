import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checker = path.resolve("scripts/check-v0.1-release-gate.mjs");

function fixture(version = "0.1.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-release-gate-"));
  fs.mkdirSync(path.join(root, "src-tauri"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "Cargo.toml"), `[workspace.package]\nversion = "0.1.0"\n`);
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      productName: "Fjord",
      version: "0.1.0",
      build: { frontendDist: "../dist" },
      app: { windows: [{}] },
      bundle: {},
    }),
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.sidecar.conf.json"),
    JSON.stringify({ bundle: { externalBin: ["binaries/fjord-askpass"] } }),
  );
  return root;
}

function run(root, ref = "v0.1.0") {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: ref },
  });
}

test("accepts only coherent v0.1.0 release metadata on the exact tag", () => {
  const root = fixture();
  try {
    assert.equal(run(root).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for version drift and a non-release ref", () => {
  const drifted = fixture("0.1.1");
  const coherent = fixture();
  try {
    assert.notEqual(run(drifted).status, 0);
    assert.notEqual(run(coherent, "develop").status, 0);
  } finally {
    fs.rmSync(drifted, { recursive: true, force: true });
    fs.rmSync(coherent, { recursive: true, force: true });
  }
});
