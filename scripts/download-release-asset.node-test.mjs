import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { startMockGitHubServer, stopMockGitHubServer } from "./github-releases-test-server.mjs";

const script = path.resolve("scripts/download-release-asset.mjs");

let server;
let baseUrl;
let assetResponses;

before(async () => {
  ({ server, baseUrl } = await startMockGitHubServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/repos\/TheZan\/Fjord\/releases\/assets\/(\d+)$/);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }

    // Assert the request looks like the real GitHub asset-download request
    // this fix depends on — wrong headers here would silently 404/406
    // against the real API even though this mock would happily 200 them.
    assert.equal(req.headers.authorization, "Bearer test-token");
    assert.equal(req.headers.accept, "application/octet-stream");

    const entry = assetResponses[match[1]];
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(entry);
  }));
});

after(() => stopMockGitHubServer(server));

// Async `spawn`, not `spawnSync` — synchronous spawn would freeze this
// process's event loop, which the in-process mock server needs in order to
// answer the child process's request at all.
function run(assetId, outputPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "TheZan", "Fjord", String(assetId), outputPath], {
      env: { PATH: process.env.PATH, FJORD_GITHUB_API_BASE: baseUrl, GH_TOKEN: "test-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("downloads latest.json's exact text content through the authenticated asset endpoint", async () => {
  const manifest = JSON.stringify({ version: "0.1.0", platforms: {} });
  assetResponses = { 501: Buffer.from(manifest, "utf8") };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-download-asset-"));
  const outputPath = path.join(dir, "latest.json");
  try {
    const result = await run(501, outputPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(outputPath, "utf8"), manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloads a binary asset byte-for-byte", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  assetResponses = { 502: bytes };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-download-asset-"));
  const outputPath = path.join(dir, "asset.bin");
  try {
    const result = await run(502, outputPath);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(outputPath), bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing asset (e.g. latest.json not attached yet) fails closed instead of writing an empty file", async () => {
  assetResponses = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fjord-download-asset-"));
  const outputPath = path.join(dir, "latest.json");
  try {
    const result = await run(999, outputPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub API error 404/);
    assert.ok(!fs.existsSync(outputPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
