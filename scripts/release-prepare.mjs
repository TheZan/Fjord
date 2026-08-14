// `npm run release:prepare -- 0.2.0` — the single place a Fjord version bump
// happens. Validates SemVer, requires a clean tree, refuses to compound
// pre-existing version drift, updates every canonical version location plus
// both lockfiles, creates a release-note skeleton if one doesn't exist yet,
// and re-verifies the result with the same `verifyReleaseMetadata` CI uses.
//
// `prepareRelease` is exported (not just a CLI) so `release-start.mjs` can
// call it in-process instead of duplicating or shelling out to this logic.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  isValidSemver,
  readCargoLockMemberVersions,
  readVersionLocations,
  verifyReleaseMetadata,
  writeVersion,
} from "./release-lib.mjs";
import { releaseNotesPath, renderSkeleton } from "./release-notes-lib.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function requireCleanTree(cwd) {
  const status = git(["status", "--porcelain"], cwd);
  if (status.trim().length > 0) {
    throw new Error(
      "release:prepare requires a clean working tree; commit or stash pending changes first",
    );
  }
}

/** Step 3 of the spec: catch drift that already existed before we touch anything. */
function requireCoherentCurrentState(cwd) {
  const locations = readVersionLocations(cwd);
  const values = Object.values(locations);
  const reference = values[0];
  const drift = Object.entries(locations).filter(([, value]) => value !== reference);

  const memberVersions = readCargoLockMemberVersions(cwd);
  const memberDrift = Object.entries(memberVersions).filter(([, value]) => value !== reference);

  if (drift.length > 0 || memberDrift.length > 0) {
    const lines = [
      ...drift.map(([source, value]) => `${source} = ${JSON.stringify(value ?? null)}`),
      ...memberDrift.map(([member, value]) => `Cargo.lock package "${member}" = "${value}"`),
    ];
    throw new Error(
      `release:prepare found pre-existing version inconsistencies and refuses to compound them:\n${lines
        .map((line) => `  - ${line}`)
        .join("\n")}`,
    );
  }
}

export function prepareRelease(version, { cwd = process.cwd() } = {}) {
  if (!isValidSemver(version)) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}: expected SemVer MAJOR.MINOR.PATCH with no pre-release suffix`,
    );
  }

  requireCleanTree(cwd);
  requireCoherentCurrentState(cwd);

  const changed = writeVersion(cwd, version);

  const notesPath = releaseNotesPath(cwd, version);
  let notesCreated = false;
  if (!fs.existsSync(notesPath)) {
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, renderSkeleton(version));
    notesCreated = true;
    changed.push(path.relative(cwd, notesPath));
  }

  const verification = verifyReleaseMetadata(cwd);
  if (!verification.ok) {
    throw new Error(
      `release:prepare wrote version ${version} but metadata verification still failed:\n${verification.problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
  }

  return { version, changed, notesPath, notesCreated };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/release-prepare.mjs <version>   (e.g. 0.2.0)");
    process.exit(1);
  }

  try {
    const cwd = process.cwd();
    const result = prepareRelease(version, { cwd });
    console.log(`release:prepare: version ${result.version}`);
    console.log("Updated version locations:");
    for (const file of result.changed) console.log(`  - ${file}`);
    console.log(
      result.notesCreated
        ? `Created release-note skeleton at ${path.relative(cwd, result.notesPath)} — fill it in before tagging.`
        : `Release notes already exist at ${path.relative(cwd, result.notesPath)}.`,
    );
  } catch (error) {
    console.error(`release:prepare: FAILED\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
