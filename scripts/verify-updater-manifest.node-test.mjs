import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/verify-updater-manifest.mjs");
const VERSION = "0.2.0";
const TAG = "v0.2.0";

function assetUrl(filename) {
  return `https://github.com/TheZan/Fjord/releases/download/${TAG}/${filename}`;
}

function writeFixtures(manifest, assetNames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-updater-manifest-"));
  const manifestPath = path.join(dir, "latest.json");
  const assetNamesPath = path.join(dir, "asset-names.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(assetNamesPath, JSON.stringify(assetNames));
  return { dir, manifestPath, assetNamesPath };
}

function run(manifestPath, assetNamesPath) {
  return spawnSync(process.execPath, [script, VERSION, TAG, manifestPath, assetNamesPath], { encoding: "utf8" });
}

test("passes for a complete manifest with matching assets", () => {
  const manifest = {
    version: VERSION,
    platforms: {
      "windows-x86_64": { signature: "s", url: assetUrl("Fjord_0.2.0_x64-setup.exe") },
      "linux-x86_64": { signature: "s", url: assetUrl("Fjord_0.2.0_amd64.AppImage") },
      "darwin-aarch64": { signature: "s", url: assetUrl("a.tar.gz") },
      "darwin-x86_64": { signature: "s", url: assetUrl("b.tar.gz") },
    },
  };
  const assetNames = ["Fjord_0.2.0_x64-setup.exe", "Fjord_0.2.0_amd64.AppImage", "a.tar.gz", "b.tar.gz"];
  const { dir, manifestPath, assetNamesPath } = writeFixtures(manifest, assetNames);
  try {
    const result = run(manifestPath, assetNamesPath);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when a required platform is missing from a partial matrix", () => {
  const manifest = {
    version: VERSION,
    platforms: {
      "windows-x86_64": { signature: "s", url: assetUrl("Fjord_0.2.0_x64-setup.exe") },
      "linux-x86_64": { signature: "s", url: assetUrl("Fjord_0.2.0_amd64.AppImage") },
    },
  };
  const assetNames = ["Fjord_0.2.0_x64-setup.exe", "Fjord_0.2.0_amd64.AppImage"];
  const { dir, manifestPath, assetNamesPath } = writeFixtures(manifest, assetNames);
  try {
    const result = run(manifestPath, assetNamesPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /darwin-aarch64/);
    assert.match(result.stderr, /darwin-x86_64/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when the manifest file itself is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-updater-manifest-"));
  try {
    const assetNamesPath = path.join(dir, "asset-names.json");
    fs.writeFileSync(assetNamesPath, "[]");
    const result = run(path.join(dir, "does-not-exist.json"), assetNamesPath);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
