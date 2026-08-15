// Structural regression test over `.github/workflows/release.yml` itself —
// the actual bug in release #2 was an *architectural* one (a single shared
// step whose `env:` always referenced `secrets.APPLE_*`, which GitHub
// Actions turns into empty strings rather than absent variables when the
// secrets aren't set). No amount of unit-testing `apple-signing-lib.mjs` in
// isolation catches a regression where someone later merges the unsigned
// and signed macOS steps back into one — only reading the workflow file
// itself does. No YAML parser dependency: the steps this checks are simple,
// well-formed blocks, so plain indentation-aware text extraction is enough
// and keeps this test free of new dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.resolve(".github/workflows/release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

const APPLE_SIGNING_VARS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];

function extractStepBlock(name) {
  const lines = workflow.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(startIndex !== -1, `step "${name}" was not found in ${workflowPath}`);

  const stepIndent = lines[startIndex].match(/^(\s*)/)[1].length;
  const block = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) {
      block.push(line);
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    const isNextStep = line.trim().startsWith("- ") && indent === stepIndent;
    const isDedent = indent < stepIndent;
    if (isNextStep || isDedent) break;
    block.push(line);
  }
  return block.join("\n");
}

test("the unsigned macOS release step never references any Apple signing variable", () => {
  const block = extractStepBlock("Build and create/update release (macOS, unsigned)");
  for (const name of APPLE_SIGNING_VARS) {
    assert.ok(!block.includes(name), `unsigned macOS step must not reference ${name}:\n${block}`);
  }
});

test("the Windows/Linux release step never references any Apple signing variable", () => {
  const block = extractStepBlock("Build and create/update release (Windows/Linux)");
  for (const name of APPLE_SIGNING_VARS) {
    assert.ok(!block.includes(name), `Windows/Linux step must not reference ${name}:\n${block}`);
  }
});

test("the signed macOS release step configures every required Apple signing variable", () => {
  const block = extractStepBlock("Build and create/update release (macOS, signed)");
  for (const name of ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    assert.ok(block.includes(name), `signed macOS step must configure ${name}`);
  }
});

test("release.yml no longer has a workflow_dispatch trigger", () => {
  assert.ok(!workflow.includes("workflow_dispatch"), "release.yml must be tag-triggered only (push: tags:)");
});
