// `node scripts/download-release-asset.mjs <owner> <repo> <assetId> <outputPath>`
// — used by `.github/workflows/release.yml`'s `packaging-verification` job
// to fetch `latest.json`'s actual bytes from a still-draft release. Plain
// `curl` against the asset's `browser_download_url` 404s while draft (see
// `downloadReleaseAsset` in `github-releases-client.mjs` for why); this
// goes through the authenticated Release Asset API instead, which works
// for draft assets.

import fs from "node:fs";
import process from "node:process";

import { downloadReleaseAsset } from "./github-releases-client.mjs";

const [owner, repo, assetId, outputPath] = process.argv.slice(2);
if (!owner || !repo || !assetId || !outputPath) {
  console.error("usage: node scripts/download-release-asset.mjs <owner> <repo> <assetId> <outputPath>");
  process.exit(1);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("download-release-asset: GH_TOKEN or GITHUB_TOKEN must be set");
  process.exit(1);
}

try {
  const buffer = await downloadReleaseAsset({ owner, repo, token, assetId: Number(assetId) });
  fs.writeFileSync(outputPath, buffer);
} catch (error) {
  console.error(`download-release-asset: FAILED\n  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
