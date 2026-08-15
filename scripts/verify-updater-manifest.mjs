// `node scripts/verify-updater-manifest.mjs <version> <tag> <manifest.json> <asset-names.json>`
// — used by `.github/workflows/release.yml`'s `packaging-verification` job.
// `asset-names.json` is a plain JSON array of every asset name currently
// attached to the release (`gh api .../releases/tags/<tag> | jq '[.assets[].name]'`),
// so this stays a pure function of files on disk — no network calls of its
// own, easy to feed fixtures to in tests.

import fs from "node:fs";
import process from "node:process";

import { verifyUpdaterManifest } from "./updater-manifest-lib.mjs";

const [version, tag, manifestPath, assetNamesPath] = process.argv.slice(2);

if (!version || !tag || !manifestPath || !assetNamesPath) {
  console.error("usage: node scripts/verify-updater-manifest.mjs <version> <tag> <manifest.json> <asset-names.json>");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`verify-updater-manifest: FAILED\n  - could not read/parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let assetNames;
try {
  assetNames = JSON.parse(fs.readFileSync(assetNamesPath, "utf8"));
  if (!Array.isArray(assetNames)) throw new Error("expected a JSON array");
} catch (error) {
  console.error(`verify-updater-manifest: FAILED\n  - could not read/parse ${assetNamesPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const result = verifyUpdaterManifest({ manifest, version, tag, assetNames });

if (!result.ok) {
  console.error("verify-updater-manifest: FAILED");
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`verify-updater-manifest: OK — v${version}, all required platforms present`);
