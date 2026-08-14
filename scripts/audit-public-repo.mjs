import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const self = "scripts/audit-public-repo.mjs";
const findings = [];
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["URL userinfo", /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g],
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function scan(label, text) {
  for (const [kind, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (
        kind === "URL userinfo" &&
        /(?:example\.(?:com|test)|\.invalid|localhost|127\.0\.0\.1|\[REDACTED\])/i.test(value)
      ) {
        continue;
      }
      findings.push(`${label}: possible ${kind}`);
    }
  }
}

const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (file === self) continue;
  if (/(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|ed25519)|credentials?|secrets?)(?:$|\.)/i.test(file)) {
    findings.push(`${file}: sensitive filename`);
  }
  if (/\.(?:pem|p12|pfx|key|mobileprovision)$/i.test(file)) {
    findings.push(`${file}: sensitive file extension`);
  }
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) continue;
  scan(file, bytes.toString("utf8"));
}

scan("git history", git(["log", "--all", "-p", "--no-ext-diff", "--no-renames", "--format=commit %H"]));

const required = [
  "README.md",
  "README.ru.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE-MIT",
  "LICENSE-APACHE",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  "assets/screenshots/fjord-workspace-overview.png",
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) findings.push(`${file}: required public file missing`);
}
if (files.some((file) => file.startsWith(".testagent/"))) {
  findings.push(".testagent/: internal planning artifacts remain in the publication tree");
}
const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
if (!cargo.includes('license = "MIT OR Apache-2.0"')) {
  findings.push("Cargo.toml: dual-license declaration drifted");
}

if (findings.length > 0) {
  process.stderr.write(`Public repository audit failed:\n- ${findings.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public repository audit: OK (${files.length} current files + full Git patch history)\n`);
}
