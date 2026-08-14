import fs from "node:fs";
import process from "node:process";

import { evaluateLaunchGate } from "./v0.1-launch-gate-lib.mjs";

const manifestPath = process.argv[2] ?? "docs/v0.1-launch-evidence.json";

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const result = evaluateLaunchGate(manifest);
  process.stdout.write(`${result.decision}\n`);
  if (!result.ready) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`BLOCKED: launch evidence could not be read: ${message}\n`);
  process.exitCode = 1;
}
