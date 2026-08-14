// `npm run release:start -- 0.2.0` — begins a GitFlow release branch from a
// clean `develop` and runs the same version-preparation logic as
// `release-prepare.mjs` (imported directly, not spawned, so there's one
// implementation of "prepare a release"). Never pushes, merges, or tags —
// those stay intentional human actions (docs/releasing.md).

import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isValidSemver } from "./release-lib.mjs";
import { prepareRelease } from "./release-prepare.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function requireCleanTree(cwd) {
  if (git(["status", "--porcelain"], cwd).length > 0) {
    throw new Error("release:start requires a clean working tree; commit or stash pending changes first");
  }
}

function requireOnDevelop(cwd) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch !== "develop") {
    throw new Error(`release:start must run from "develop"; current branch is "${branch}"`);
  }
}

function branchExists(cwd, branch) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function startRelease(version, { cwd = process.cwd() } = {}) {
  if (!isValidSemver(version)) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}: expected SemVer MAJOR.MINOR.PATCH with no pre-release suffix`,
    );
  }

  requireCleanTree(cwd);
  requireOnDevelop(cwd);

  const branch = `release/${version}`;
  if (branchExists(cwd, branch)) {
    throw new Error(`branch "${branch}" already exists locally`);
  }

  git(["checkout", "-b", branch], cwd);

  const result = prepareRelease(version, { cwd });
  return { branch, ...result };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/release-start.mjs <version>   (e.g. 0.2.0)");
    process.exit(1);
  }

  try {
    const result = startRelease(version);
    console.log(`release:start: created and switched to ${result.branch}`);
    console.log("Updated version locations:");
    for (const file of result.changed) console.log(`  - ${file}`);
    console.log(
      "Nothing was pushed, merged, or tagged. Review the diff, fill in the release notes, commit, and push the branch yourself.",
    );
  } catch (error) {
    console.error(`release:start: FAILED\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
