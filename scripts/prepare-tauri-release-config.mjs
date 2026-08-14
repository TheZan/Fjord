import { readFileSync, writeFileSync } from "node:fs";

const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(readFileSync(configPath, "utf8"));

const required = [
  "TAURI_UPDATER_PUBKEY",
  "TAURI_UPDATE_ENDPOINT",
  "TAURI_SIGNING_PRIVATE_KEY",
];

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(`Missing required release secret(s): ${missing.join(", ")}`);
}

config.bundle = {
  ...config.bundle,
  createUpdaterArtifacts: true,
};

if (process.env.WINDOWS_CERTIFICATE_THUMBPRINT) {
  config.bundle.windows = {
    ...config.bundle.windows,
    certificateThumbprint: process.env.WINDOWS_CERTIFICATE_THUMBPRINT,
    digestAlgorithm: "sha256",
    timestampUrl:
      process.env.WINDOWS_TIMESTAMP_URL ?? "http://timestamp.digicert.com",
  };
}

config.plugins = {
  ...config.plugins,
  updater: {
    pubkey: process.env.TAURI_UPDATER_PUBKEY,
    endpoints: [process.env.TAURI_UPDATE_ENDPOINT],
  },
};

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
