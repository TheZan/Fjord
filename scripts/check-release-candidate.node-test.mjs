import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { candidateMarker } from "./release-discovery-lib.mjs";
import { sendJson, startMockGitHubServer, stopMockGitHubServer } from "./github-releases-test-server.mjs";

const script = path.resolve("scripts/check-release-candidate.mjs");
const SHA = "3e1f10c95fc1927d2e82331040d54c1468f583d5";

let server;
let baseUrl;
let releases;
let assetsByRelease;
let deletedAssetIds;

before(async () => {
  ({ server, baseUrl } = await startMockGitHubServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/repos/TheZan/Fjord/releases") {
      const page = Number(url.searchParams.get("page") || "1");
      sendJson(res, 200, page === 1 ? releases : []);
      return;
    }

    const assetsMatch = url.pathname.match(/^\/repos\/TheZan\/Fjord\/releases\/(\d+)\/assets$/);
    if (req.method === "GET" && assetsMatch) {
      const page = Number(url.searchParams.get("page") || "1");
      sendJson(res, 200, page === 1 ? (assetsByRelease[assetsMatch[1]] ?? []) : []);
      return;
    }

    const deleteMatch = url.pathname.match(/^\/repos\/TheZan\/Fjord\/releases\/assets\/(\d+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      deletedAssetIds.push(Number(deleteMatch[1]));
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { message: "not found" });
  }));
});

after(() => stopMockGitHubServer(server));

// Async `spawn`, not `spawnSync` — a synchronous spawn would block this
// process's event loop, which the in-process mock HTTP server above needs
// in order to answer the child process's requests at all (self-deadlock).
function run() {
  return new Promise((resolve) => {
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fjord-candidate-")), "github_output");
    fs.writeFileSync(outputPath, "");
    const child = spawn(process.execPath, [script, "TheZan", "Fjord", "v0.1.0", SHA], {
      env: { PATH: process.env.PATH, FJORD_GITHUB_API_BASE: baseUrl, GH_TOKEN: "test-token", GITHUB_OUTPUT: outputPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      const output = fs.readFileSync(outputPath, "utf8");
      fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
      resolve({ status, stdout, stderr, output });
    });
  });
}

test("no existing release -> exits 0, no release_id written", async () => {
  releases = [];
  assetsByRelease = {};
  deletedAssetIds = [];
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "");
});

test("same-candidate draft -> exits 0, writes release_id, clears stale assets", async () => {
  releases = [{ id: 42, tag_name: "v0.1.0", draft: true, body: `notes\n${candidateMarker(SHA)}\n` }];
  assetsByRelease = { 42: [{ id: 901, name: "old.exe" }, { id: 902, name: "latest.json" }] };
  deletedAssetIds = [];
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^release_id=42$/m);
  assert.deepEqual(deletedAssetIds.sort(), [901, 902]);
});

test("different-candidate draft -> exits non-zero, deletes nothing", async () => {
  releases = [{ id: 43, tag_name: "v0.1.0", draft: true, body: `notes\n${candidateMarker("0000000000000000000000000000000000000000")}\n` }];
  assetsByRelease = { 43: [{ id: 903, name: "stale.exe" }] };
  deletedAssetIds = [];
  const result = await run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::/);
  assert.match(result.stderr, new RegExp(SHA));
  assert.equal(result.output, "");
  assert.deepEqual(deletedAssetIds, []);
});

test("published release for the tag -> exits non-zero, never touches assets", async () => {
  releases = [{ id: 44, tag_name: "v0.1.0", draft: false, body: "notes" }];
  assetsByRelease = {};
  deletedAssetIds = [];
  const result = await run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already has a published release/);
  assert.deepEqual(deletedAssetIds, []);
});
