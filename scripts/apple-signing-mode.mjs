// `node scripts/apple-signing-mode.mjs` — CLI used by
// `.github/workflows/release.yml`'s macOS matrix legs. Writes
// `mode=unsigned|signed` to `$GITHUB_OUTPUT` so the workflow can select
// between two entirely separate `tauri-apps/tauri-action` step declarations
// (see release.yml) — the decision itself never determines which env vars
// reach that step; the step's own `env:` block (or lack of one) does. Exits
// non-zero on a partial configuration, failing the job before any build
// work happens.

import fs from "node:fs";
import process from "node:process";

import { decideAppleSigningMode } from "./apple-signing-lib.mjs";

const result = decideAppleSigningMode(process.env);

if (result.mode === "error") {
  console.error(`::error::${result.message}`);
  process.exit(1);
}

console.log(result.mode === "unsigned" ? `::notice::${result.message}` : result.message);

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `mode=${result.mode}\n`);
}
