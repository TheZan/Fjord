import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.FJORD_SIDECAR_TARGET ?? rustHostTarget();
const profile = process.env.FJORD_SIDECAR_PROFILE ?? "release";
const targetDirectory = resolve(
  repositoryRoot,
  process.env.CARGO_TARGET_DIR ?? "target",
);
const windows = target.includes("windows");
const extension = windows ? ".exe" : "";
const fileName = `fjord-askpass${extension}`;
const candidates = [
  resolve(targetDirectory, target, profile, fileName),
  resolve(targetDirectory, profile, fileName),
];
const source = candidates.find(fileExists);

if (!source) {
  throw new Error(
    `fjord-askpass binary not found for ${target}; checked: ${candidates.join(", ")}`,
  );
}

const destination = resolve(
  repositoryRoot,
  "src-tauri",
  "binaries",
  `fjord-askpass-${target}${extension}`,
);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (!windows) chmodSync(destination, 0o755);

console.log(`Prepared ${destination}`);

function rustHostTarget() {
  const details = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = details.match(/^host:\s*(.+)$/m)?.[1]?.trim();
  if (!host) throw new Error("Could not determine Rust host target");
  return host;
}

function fileExists(path) {
  return existsSync(path);
}
