// Fails closed if Fjord's version metadata is inconsistent anywhere, or (with
// `--tag`) if the given `vX.Y.Z` ref doesn't match the project version.
// The exact same check runs locally (`npm run release:verify`) and in CI
// (`.github/workflows/release.yml`, `ci.yml`) via `verifyReleaseMetadata`
// in `release-lib.mjs` — there is only one implementation.

import process from "node:process";
import { verifyReleaseMetadata } from "./release-lib.mjs";

function readTagArg(argv) {
  const index = argv.indexOf("--tag");
  return index === -1 ? undefined : argv[index + 1];
}

const tag = readTagArg(process.argv.slice(2));
const result = verifyReleaseMetadata(process.cwd(), { tag });

if (!result.ok) {
  console.error("release:verify: FAILED");
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

process.stdout.write(
  `release:verify: OK — version ${result.version}${tag ? ` matches tag ${tag}` : ""}\n`,
);
