// Shared release-notes helpers used by `release-prepare.mjs` (skeleton
// creation) and `check-release-notes.mjs` (content validation) — one
// definition of "what a Fjord release note must contain", generalized from
// the v0.1-only `docs/releases/fjord-v0.1.0-early-preview.md` gate.

import fs from "node:fs";
import path from "node:path";

export const REQUIRED_HEADINGS = [
  "## Supported platforms",
  "## What is included",
  "## Workspace-first workflow",
  "## Important limitations",
  "## Safety expectations",
  "## Reporting bugs and security issues",
  "## Installation and verification",
];

// Facts every release note must restate, regardless of version — kept
// generic (no exact OS-version literals) so a later "Windows 10/11" or
// "macOS 14" wording doesn't require touching this checker.
export const REQUIRED_PHRASES = [
  "Windows",
  "macOS",
  "Ubuntu",
  "installed system Git",
  "Early Preview",
  "security/advisories/new",
];

export function titleHeading(version) {
  return `# Fjord v${version} — Early Preview`;
}

export function releaseNotesPath(root, version) {
  return path.join(root, "docs", "releases", `fjord-v${version}.md`);
}

/**
 * `fjord-v0.1.0.md` is the convention every release from here on uses.
 * `fjord-v0.1.0-early-preview.md` predates this generalization and stays as
 * historical evidence rather than being renamed out from under
 * `docs/release.md`/`docs/v0.1-launch-decision.md`'s existing links — this
 * only widens *lookup*, not what `release-prepare.mjs` creates going forward.
 */
export function resolveReleaseNotesPath(root, version) {
  const canonical = releaseNotesPath(root, version);
  if (fs.existsSync(canonical)) return canonical;

  const legacy = path.join(root, "docs", "releases", `fjord-v${version}-early-preview.md`);
  if (fs.existsSync(legacy)) return legacy;

  return canonical;
}

/**
 * A structural skeleton, not generated content: every section is a
 * placeholder a human must replace before `check-release-notes.mjs` passes
 * (the placeholder text below deliberately matches its unfinished-content
 * detector). Release notes are never invented from commit history.
 */
export function renderSkeleton(version) {
  return `${titleHeading(version)}

Fjord is a cross-platform, workspace-first Git desktop application.

> **Early Preview:** intended for evaluation and everyday workflows where
> users retain normal Git backups and review safety prompts. It is not a
> stable-support promise.

## Supported platforms

- Windows [fill in supported version] x64: NSIS installer.
- macOS [fill in supported version] or newer: package for Intel and Apple
  Silicon.
- Ubuntu [fill in supported version] or newer x64: AppImage.

[Confirm this candidate's actual code-signing status here — e.g. "packages
are not code-signed; Windows SmartScreen and macOS Gatekeeper will show an
unknown-publisher warning on first run" or, once signing is configured,
"Windows and macOS packages are signed" / "...and notarized".]

Remote operations require an installed system Git; local repository reads
remain available when network access is unavailable.

## What is included

[Describe the headline change here — new capabilities and behavior users will
notice in this release.]

## Workspace-first workflow

[Restate or update the workspace-first model description for this release.]

## Important limitations

[List what is deliberately out of scope for this release.]

## Safety expectations

[Restate backup/recovery guarantees and any changes to them in this release.]

## Reporting bugs and security issues

Use the [bug report form](https://github.com/TheZan/Fjord/issues/new?template=bug_report.yml)
for reproducible non-security problems. Include Fjord version, OS, minimal steps,
expected/actual behavior, and only bounded sanitized logs. Do not attach private
repository contents, full diffs, credentials, signing keys, or URLs with userinfo.

Report vulnerabilities privately through the
[security advisory form](https://github.com/TheZan/Fjord/security/advisories/new)
as described in [\`SECURITY.md\`](../../SECURITY.md).

## Installation and verification

[Confirm the exact release-workflow evidence this candidate satisfies before
publishing: same-SHA CI, signed artifact checks, and any manual verification
performed. Download only artifacts attached to the \`v${version}\` GitHub
Release.]
`;
}

export function validateReleaseNotes(content, version) {
  const problems = [];
  // Most of docs/ is checked in with CRLF line endings (not `eol=lf`-pinned
  // in .gitattributes), so a heading-presence check keyed on a literal `\n`
  // never matches on a normal Windows checkout — same class of bug as
  // `CARGO_LOCK_MEMBER_RE` in release-lib.mjs. Normalize once up front
  // rather than threading `\r?\n` through every substring/indexOf check
  // below.
  const normalized = content.replace(/\r\n/g, "\n");
  const required = [titleHeading(version), ...REQUIRED_HEADINGS];

  const missing = required.filter((heading) => !normalized.includes(`${heading}\n`));
  for (const heading of missing) problems.push(`missing required section: ${heading}`);

  if (/\b(?:TODO|TBC|TBD)\b|<[^>]+(?:here|url|text|date)[^>]*>|\[[^\]]*(?:fill in|describe|restate|list|confirm)[^\]]*\]/i.test(normalized)) {
    problems.push("release notes contain an unfinished placeholder");
  }

  for (const heading of REQUIRED_HEADINGS) {
    if (missing.includes(heading)) continue;
    const start = normalized.indexOf(`${heading}\n`) + heading.length + 1;
    const next = normalized.indexOf("\n## ", start);
    const body = normalized.slice(start, next === -1 ? normalized.length : next).trim();
    if (body.length < 40) problems.push(`${heading} is not populated`);
  }

  for (const phrase of REQUIRED_PHRASES) {
    if (!normalized.includes(phrase)) problems.push(`release notes are missing required phrase: ${phrase}`);
  }

  return { ok: problems.length === 0, problems };
}
