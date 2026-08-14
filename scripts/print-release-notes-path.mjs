// `node scripts/print-release-notes-path.mjs <version>` — prints the
// resolved release-notes path (canonical `fjord-v<version>.md`, or the
// legacy `-early-preview` filename for v0.1.0) for shell steps that need it
// as plain text, e.g. `.github/workflows/release.yml`'s release-body step.
// Reuses `resolveReleaseNotesPath` from `release-notes-lib.mjs` rather than
// re-implementing the fallback rule inline in YAML.

import process from "node:process";
import { resolveReleaseNotesPath } from "./release-notes-lib.mjs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/print-release-notes-path.mjs <version>");
  process.exit(1);
}

process.stdout.write(resolveReleaseNotesPath(process.cwd(), version));
