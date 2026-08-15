import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_UPDATER_PLATFORMS, verifyUpdaterManifest } from "./updater-manifest-lib.mjs";

const VERSION = "0.2.0";
const TAG = "v0.2.0";

function assetUrl(filename) {
  return `https://github.com/TheZan/Fjord/releases/download/${TAG}/${filename}`;
}

function fullManifest() {
  return {
    version: VERSION,
    notes: "",
    pub_date: "2026-08-15T00:00:00Z",
    platforms: {
      "windows-x86_64": { signature: "sig-win", url: assetUrl("Fjord_0.2.0_x64-setup.exe") },
      "linux-x86_64": { signature: "sig-linux", url: assetUrl("Fjord_0.2.0_amd64.AppImage") },
      "darwin-aarch64": { signature: "sig-mac-arm", url: assetUrl("Fjord.aarch64.app.tar.gz") },
      "darwin-x86_64": { signature: "sig-mac-intel", url: assetUrl("Fjord.x64.app.tar.gz") },
    },
  };
}

function fullAssetNames() {
  return [
    "Fjord_0.2.0_x64-setup.exe",
    "Fjord_0.2.0_x64-setup.exe.sig",
    "Fjord_0.2.0_amd64.AppImage",
    "Fjord_0.2.0_amd64.AppImage.sig",
    "Fjord.aarch64.app.tar.gz",
    "Fjord.aarch64.app.tar.gz.sig",
    "Fjord.x64.app.tar.gz",
    "Fjord.x64.app.tar.gz.sig",
    "latest.json",
  ];
}

test("a complete manifest with matching assets passes", () => {
  const result = verifyUpdaterManifest({ manifest: fullManifest(), version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("missing manifest fails with a single clear problem", () => {
  const result = verifyUpdaterManifest({ manifest: null, version: VERSION, tag: TAG, assetNames: [] });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
});

test("a partially successful matrix (one platform missing) fails closed", () => {
  const manifest = fullManifest();
  delete manifest.platforms["darwin-aarch64"];
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("darwin-aarch64")));
});

test("every required platform is checked independently", () => {
  const result = verifyUpdaterManifest({ manifest: { version: VERSION, platforms: {} }, version: VERSION, tag: TAG, assetNames: [] });
  assert.equal(result.ok, false);
  for (const platform of REQUIRED_UPDATER_PLATFORMS) {
    assert.ok(result.problems.some((p) => p.includes(platform)), `expected a problem mentioning ${platform}`);
  }
});

test("wrong top-level version fails", () => {
  const manifest = fullManifest();
  manifest.version = "0.1.0";
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes(".version")));
});

test("a missing signature fails even if the url is fine", () => {
  const manifest = fullManifest();
  manifest.platforms["windows-x86_64"].signature = "";
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("windows-x86_64") && p.includes("signature")));
});

test("a url pointing at a different tag fails (stale/cross-candidate artifact)", () => {
  const manifest = fullManifest();
  manifest.platforms["linux-x86_64"].url = "https://github.com/TheZan/Fjord/releases/download/v0.1.0/Fjord_0.1.0_amd64.AppImage";
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("linux-x86_64") && p.includes("does not point at this release")));
});

test("a url referencing an artifact that isn't actually attached fails", () => {
  const manifest = fullManifest();
  manifest.platforms["darwin-x86_64"].url = assetUrl("Fjord.x64.app.tar.gz.stale-leftover");
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("not an attached release asset")));
});

test("an invalid url string fails instead of throwing", () => {
  const manifest = fullManifest();
  manifest.platforms["windows-x86_64"].url = "not a url";
  const result = verifyUpdaterManifest({ manifest, version: VERSION, tag: TAG, assetNames: fullAssetNames() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("not a valid URL")));
});
