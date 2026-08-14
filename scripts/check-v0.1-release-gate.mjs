import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const expected = "0.1.0";
const allowUntagged = process.argv.includes("--allow-untagged");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const sidecarConfig = readJson("src-tauri/tauri.sidecar.conf.json");
const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];

const versions = {
  "package.json": packageJson.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "Cargo.toml workspace": cargoVersion,
};
for (const [source, version] of Object.entries(versions)) {
  if (version !== expected) {
    throw new Error(`${source} must be ${expected}; found ${version ?? "missing"}`);
  }
}

if (tauriConfig.productName !== "Fjord") {
  throw new Error(`productName must be Fjord; found ${tauriConfig.productName ?? "missing"}`);
}
if (tauriConfig.build?.frontendDist !== "../dist") {
  throw new Error("release builds must use the compiled frontendDist");
}
if (tauriConfig.app?.windows?.some((window) => window.devtools === true)) {
  throw new Error("release windows must not enable devtools");
}
if (
  JSON.stringify(tauriConfig.bundle?.resources ?? []).match(/fixture|test[-_ ]?data|\.env/i) ||
  JSON.stringify(sidecarConfig.bundle?.resources ?? []).match(/fixture|test[-_ ]?data|\.env/i)
) {
  throw new Error("development fixture/config resources must not be bundled");
}
if (JSON.stringify(sidecarConfig.bundle?.externalBin) !== JSON.stringify(["binaries/fjord-askpass"])) {
  throw new Error("the release sidecar config must contain only fjord-askpass");
}

const refName = process.env.GITHUB_REF_NAME;
if (!allowUntagged && refName !== `v${expected}`) {
  throw new Error(`v0.1 release must run from tag v${expected}; found ${refName ?? "no tag"}`);
}

process.stdout.write(`v${expected} release metadata: OK\n`);
