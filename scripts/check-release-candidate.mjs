// `node scripts/check-release-candidate.mjs <owner> <repo> <tag> <expectedSha>`
// — used by `.github/workflows/release.yml`'s `prerequisites` job. Replaces
// the old `actions/github-script` block that called `getReleaseByTag`, which
// only ever finds *published* releases and 404s on the intentionally still-
// draft release this workflow itself creates.
//
// Exit 0 and (on a same-candidate retry) write `release_id` to
// `$GITHUB_OUTPUT`, having cleared that release's stale assets first. Exit 1
// with `::error::` on anything unsafe — a different candidate SHA, or an
// already-published release for this tag.

import fs from "node:fs";
import process from "node:process";

import { deleteReleaseAsset, listAllReleases, listReleaseAssets } from "./github-releases-client.mjs";
import { evaluateCandidateSafety, selectReleaseByTag } from "./release-discovery-lib.mjs";

const [owner, repo, tag, expectedSha] = process.argv.slice(2);
if (!owner || !repo || !tag || !expectedSha) {
  console.error("usage: node scripts/check-release-candidate.mjs <owner> <repo> <tag> <expectedSha>");
  process.exit(1);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("check-release-candidate: GH_TOKEN or GITHUB_TOKEN must be set");
  process.exit(1);
}

function writeOutput(name, value) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) fs.appendFileSync(githubOutput, `${name}=${value}\n`);
}

try {
  const releases = await listAllReleases({ owner, repo, token });
  const release = selectReleaseByTag(releases, tag);
  const result = evaluateCandidateSafety({ release, expectedSha });

  if (!result.ok) {
    console.error(`::error::${result.message}`);
    process.exit(1);
  }

  console.log(result.message);

  if (result.status === "same-candidate") {
    writeOutput("release_id", String(release.id));
    const assets = await listReleaseAssets({ owner, repo, token, releaseId: release.id });
    for (const asset of assets) {
      await deleteReleaseAsset({ owner, repo, token, assetId: asset.id });
      console.log(`Deleted stale asset ${asset.name} from the existing draft.`);
    }
  }
} catch (error) {
  console.error(`check-release-candidate: FAILED\n  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
