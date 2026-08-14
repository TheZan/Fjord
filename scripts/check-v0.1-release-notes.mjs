import fs from "node:fs";
import process from "node:process";

const path = "docs/releases/fjord-v0.1.0-early-preview.md";
const notes = fs.readFileSync(path, "utf8");
const requiredHeadings = [
  "# Fjord v0.1.0 — Early Preview",
  "## Supported platforms",
  "## What is included",
  "## Workspace-first workflow",
  "## Important limitations",
  "## Safety expectations",
  "## Reporting bugs and security issues",
  "## Installation and verification",
];

const missing = requiredHeadings.filter((heading) => !notes.includes(`${heading}\n`));
if (missing.length > 0) {
  throw new Error(`release notes are missing required section(s): ${missing.join(", ")}`);
}
if (/\b(?:TODO|TBC|TBD)\b|<[^>]+(?:here|url|text|date)[^>]*>/i.test(notes)) {
  throw new Error("release notes contain an unfinished placeholder");
}
for (const heading of requiredHeadings.slice(1)) {
  const start = notes.indexOf(`${heading}\n`) + heading.length + 1;
  const next = notes.indexOf("\n## ", start);
  const body = notes.slice(start, next === -1 ? notes.length : next).trim();
  if (body.length < 80) throw new Error(`${heading} is not populated`);
}
for (const requiredPhrase of [
  "Windows 11 x64",
  "macOS 13",
  "Ubuntu 22.04",
  "installed system Git",
  "Early Preview",
  "security/advisories/new",
]) {
  if (!notes.includes(requiredPhrase)) throw new Error(`release notes claim is missing: ${requiredPhrase}`);
}

process.stdout.write("v0.1 release notes: OK\n");
