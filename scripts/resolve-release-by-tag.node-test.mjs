import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";

import { sendJson, startMockGitHubServer, stopMockGitHubServer } from "./github-releases-test-server.mjs";

const script = path.resolve("scripts/resolve-release-by-tag.mjs");

let server;
let baseUrl;
let releasesByPage;

before(async () => {
  ({ server, baseUrl } = await startMockGitHubServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/repos/TheZan/Fjord/releases") {
      const page = Number(url.searchParams.get("page") || "1");
      sendJson(res, 200, releasesByPage[page - 1] ?? []);
      return;
    }
    sendJson(res, 404, { message: "not found" });
  }));
});

after(() => stopMockGitHubServer(server));

// `spawnSync` would block this process's event loop, which is what the
// mock HTTP server above needs to actually answer the child's requests —
// spawning synchronously here would deadlock the child against its own
// parent. Async `spawn` keeps the event loop free.
function run(tag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "TheZan", "Fjord", tag], {
      env: { PATH: process.env.PATH, FJORD_GITHUB_API_BASE: baseUrl, GH_TOKEN: "test-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("no matching release -> prints null, exits 0", async () => {
  releasesByPage = [[{ id: 1, tag_name: "v0.2.0" }]];
  const result = await run("v0.1.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "null");
});

test("one matching draft release -> prints it as JSON, exits 0", async () => {
  const release = { id: 5, tag_name: "v0.1.0", draft: true, body: "notes" };
  releasesByPage = [[release]];
  const result = await run("v0.1.0");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), release);
});

test("one matching published release -> resolves it too (judged by the caller, not this script)", async () => {
  const release = { id: 6, tag_name: "v0.1.0", draft: false, body: "notes" };
  releasesByPage = [[release]];
  const result = await run("v0.1.0");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), release);
});

test("a match found only on a later page is still found", async () => {
  const release = { id: 7, tag_name: "v0.1.0", draft: true, body: "notes" };
  releasesByPage = [
    Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, tag_name: `v9.${i}.0` })),
    [release],
  ];
  const result = await run("v0.1.0");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), release);
});

test("ambiguous match (two releases, same tag_name) -> fails closed", async () => {
  releasesByPage = [[
    { id: 1, tag_name: "v0.1.0", draft: true, body: "a" },
    { id: 2, tag_name: "v0.1.0", draft: true, body: "b" },
  ]];
  const result = await run("v0.1.0");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambiguous/);
});
