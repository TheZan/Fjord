// `npm run check:release-notes [-- <version>]` — generalized replacement for
// the old v0.1-only `check-v0.1-release-notes.mjs`. Fails on a missing file,
// a missing/unpopulated required section, or a leftover placeholder, for any
// `docs/releases/fjord-v<version>.md`. Defaults to the project's own version
// when no version is given, so this stays runnable during normal development
// as well as with an explicit version from CI (`release.yml` always passes
// the tag's version explicitly).

import fs from "node:fs";
import process from "node:process";

import { readVersionLocations } from "./release-lib.mjs";
import { resolveReleaseNotesPath, validateReleaseNotes } from "./release-notes-lib.mjs";

const root = process.cwd();
const version = process.argv[2] ?? readVersionLocations(root)["Cargo.toml [workspace.package].version"];

const notesPath = resolveReleaseNotesPath(root, version);
if (!fs.existsSync(notesPath)) {
  console.error(`check-release-notes: FAILED\n  - ${notesPath} does not exist`);
  process.exit(1);
}

const content = fs.readFileSync(notesPath, "utf8");
const result = validateReleaseNotes(content, version);

if (!result.ok) {
  console.error(`check-release-notes: FAILED — ${notesPath}`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

process.stdout.write(`check-release-notes: OK — v${version} (${notesPath})\n`);
