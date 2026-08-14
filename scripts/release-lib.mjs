// Shared version/release-metadata helpers — the single implementation used
// by `release-verify.mjs`, `release-prepare.mjs`, `release-start.mjs`, and
// GitHub Actions (`.github/workflows/release.yml`, `ci.yml`) so there is one
// definition of "the project's version" and one definition of "consistent
// release metadata", not a CLI copy and a CI copy.
//
// Fjord is pre-1.0 SemVer with no alpha/beta/rc suffixes (docs/releasing.md).

import fs from "node:fs";
import path from "node:path";

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

export function isValidSemver(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

/** `"v0.2.0"` → `"0.2.0"`; throws on anything else (no `v`, no suffix, etc). */
export function parseTagVersion(ref) {
  const match = TAG_RE.exec(ref ?? "");
  if (!match) {
    throw new Error(`not a release tag in the form vX.Y.Z: ${JSON.stringify(ref ?? null)}`);
  }
  return match[1];
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

const CARGO_WORKSPACE_VERSION_RE = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/;
const CARGO_LOCK_MEMBER_RE = /(\[\[package\]\]\nname = "(fjord[a-z-]*)"\nversion = ")([^"]+)(")/g;

/**
 * Every location that records Fjord's own version. `Cargo.toml`'s
 * `[workspace.package].version` is treated as canonical: every other
 * location is expected to equal it exactly.
 */
export function readVersionLocations(root) {
  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const cargoMatch = CARGO_WORKSPACE_VERSION_RE.exec(cargoToml);
  if (!cargoMatch) {
    throw new Error("Cargo.toml: could not find [workspace.package].version");
  }

  const packageJson = readJson(root, "package.json");
  const packageLock = readJson(root, "package-lock.json");
  const tauriConf = readJson(root, "src-tauri/tauri.conf.json");

  return {
    "Cargo.toml [workspace.package].version": cargoMatch[2],
    "package.json .version": packageJson.version,
    'package-lock.json .version': packageLock.version,
    'package-lock.json .packages[""].version': packageLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json .version": tauriConf.version,
  };
}

/** `{ "fjord-app": "0.1.0", ... }` for every local workspace member recorded in `Cargo.lock`. */
export function readCargoLockMemberVersions(root) {
  const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
  const versions = {};
  for (const match of cargoLock.matchAll(CARGO_LOCK_MEMBER_RE)) {
    versions[match[2]] = match[3];
  }
  return versions;
}

/**
 * Patches every version location in place to `version`. `Cargo.lock` and
 * `package-lock.json` are edited textually/structurally rather than by
 * shelling out to `cargo`/`npm`, so this stays offline and deterministic —
 * both files record only the local workspace's own version here, never a
 * resolved dependency version, so a direct patch is exactly what `cargo`
 * or `npm` would themselves write back on the next build/install.
 */
export function writeVersion(root, version) {
  const changed = [];

  const cargoTomlPath = path.join(root, "Cargo.toml");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const nextCargoToml = cargoToml.replace(CARGO_WORKSPACE_VERSION_RE, `$1${version}$3`);
  if (nextCargoToml === cargoToml) throw new Error("Cargo.toml: version pattern did not match");
  fs.writeFileSync(cargoTomlPath, nextCargoToml);
  changed.push("Cargo.toml");

  const packageJson = readJson(root, "package.json");
  packageJson.version = version;
  writeJson(root, "package.json", packageJson);
  changed.push("package.json");

  const packageLock = readJson(root, "package-lock.json");
  packageLock.version = version;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  writeJson(root, "package-lock.json", packageLock);
  changed.push("package-lock.json");

  const tauriConf = readJson(root, "src-tauri/tauri.conf.json");
  tauriConf.version = version;
  writeJson(root, "src-tauri/tauri.conf.json", tauriConf);
  changed.push("src-tauri/tauri.conf.json");

  const cargoLockPath = path.join(root, "Cargo.lock");
  const cargoLock = fs.readFileSync(cargoLockPath, "utf8");
  const nextCargoLock = cargoLock.replace(CARGO_LOCK_MEMBER_RE, `$1${version}$4`);
  fs.writeFileSync(cargoLockPath, nextCargoLock);
  changed.push("Cargo.lock");

  return changed;
}

/**
 * Generalized, version-agnostic release-metadata check — the replacement for
 * the old v0.1-only `check-v0.1-release-gate.mjs`. Returns `{ ok, problems,
 * version }`; never throws for expected drift so callers can print every
 * problem at once instead of failing on the first one.
 */
export function verifyReleaseMetadata(root, { tag } = {}) {
  const problems = [];
  let version;

  try {
    const locations = readVersionLocations(root);
    const values = Object.values(locations);
    version = values[0];
    for (const [source, value] of Object.entries(locations)) {
      if (value !== version) {
        problems.push(`${source} is "${value ?? "missing"}"; expected "${version ?? "missing"}"`);
      }
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const memberVersions = readCargoLockMemberVersions(root);
    for (const [member, memberVersion] of Object.entries(memberVersions)) {
      if (memberVersion !== version) {
        problems.push(`Cargo.lock package "${member}" is "${memberVersion}"; expected "${version ?? "missing"}"`);
      }
    }
    if (Object.keys(memberVersions).length === 0) {
      problems.push("Cargo.lock: no fjord* workspace member packages were found");
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const tauriConfig = readJson(root, "src-tauri/tauri.conf.json");
    const sidecarConfig = readJson(root, "src-tauri/tauri.sidecar.conf.json");

    if (tauriConfig.productName !== "Fjord") {
      problems.push(`src-tauri/tauri.conf.json productName must be "Fjord"; found ${JSON.stringify(tauriConfig.productName ?? null)}`);
    }
    if (tauriConfig.build?.frontendDist !== "../dist") {
      problems.push("src-tauri/tauri.conf.json: release builds must use the compiled frontendDist (\"../dist\")");
    }
    if (tauriConfig.app?.windows?.some((window) => window.devtools === true)) {
      problems.push("src-tauri/tauri.conf.json: release windows must not enable devtools");
    }
    if (
      JSON.stringify(tauriConfig.bundle?.resources ?? []).match(/fixture|test[-_ ]?data|\.env/i) ||
      JSON.stringify(sidecarConfig.bundle?.resources ?? []).match(/fixture|test[-_ ]?data|\.env/i)
    ) {
      problems.push("development fixture/config resources must not be bundled");
    }
    if (JSON.stringify(sidecarConfig.bundle?.externalBin) !== JSON.stringify(["binaries/fjord-askpass"])) {
      problems.push("src-tauri/tauri.sidecar.conf.json: the release sidecar config must contain only fjord-askpass");
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (tag !== undefined && tag !== null && tag !== "") {
    try {
      const tagVersion = parseTagVersion(tag);
      if (tagVersion !== version) {
        problems.push(`tag ${JSON.stringify(tag)} is version "${tagVersion}"; project version is "${version ?? "missing"}"`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: problems.length === 0, problems, version };
}
