// `node scripts/resolve-release-by-tag.mjs <owner> <repo> <tag>` — used by
// `.github/workflows/release.yml`'s `packaging-verification` job in place of
// `gh api repos/.../releases/tags/vX.Y.Z`, which 404s on the still-draft
// release this workflow itself created (see release-discovery-lib.mjs for
// why). Prints the matching release as JSON to stdout, or the literal
// `null` if none exists. Exits non-zero only on an ambiguous match or a
// GitHub API failure — "no release found" is a legitimate result the caller
// decides how to treat (a blocker for packaging-verification, expected on a
// first run for prerequisites).

import process from "node:process";

import { listAllReleases } from "./github-releases-client.mjs";
import { selectReleaseByTag } from "./release-discovery-lib.mjs";

const [owner, repo, tag] = process.argv.slice(2);
if (!owner || !repo || !tag) {
  console.error("usage: node scripts/resolve-release-by-tag.mjs <owner> <repo> <tag>");
  process.exit(1);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("resolve-release-by-tag: GH_TOKEN or GITHUB_TOKEN must be set");
  process.exit(1);
}

try {
  const releases = await listAllReleases({ owner, repo, token });
  const release = selectReleaseByTag(releases, tag);
  process.stdout.write(release ? JSON.stringify(release) : "null");
} catch (error) {
  console.error(`resolve-release-by-tag: FAILED\n  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
