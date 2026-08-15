import assert from "node:assert/strict";
import test from "node:test";

import { deleteReleaseAsset, downloadReleaseAsset, listAllReleases, listReleaseAssets, publishRelease } from "./github-releases-client.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("listAllReleases follows pagination until a short page is returned", async () => {
  const pageSize = 2;
  const allReleases = [{ id: 1, tag_name: "v0.1.0" }, { id: 2, tag_name: "v0.2.0" }, { id: 3, tag_name: "v0.3.0" }];
  const calls = [];

  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const start = (page - 1) * pageSize;
    return jsonResponse(allReleases.slice(start, start + pageSize));
  };

  const releases = await listAllReleases({ owner: "TheZan", repo: "Fjord", token: "t", fetchImpl, perPage: pageSize });

  assert.deepEqual(releases, allReleases);
  // page 1 (2 releases, full page) -> page 2 (1 release, short page, stop).
  assert.equal(calls.length, 2);
});

test("listAllReleases stops after a single short page", async () => {
  const fetchImpl = async () => jsonResponse([{ id: 1, tag_name: "v0.1.0" }]);
  const releases = await listAllReleases({ owner: "TheZan", repo: "Fjord", token: "t", fetchImpl, perPage: 100 });
  assert.equal(releases.length, 1);
});

test("listAllReleases surfaces an empty repo as an empty array", async () => {
  const fetchImpl = async () => jsonResponse([]);
  const releases = await listAllReleases({ owner: "TheZan", repo: "Fjord", token: "t", fetchImpl });
  assert.deepEqual(releases, []);
});

test("listAllReleases throws with a clear message on an API error", async () => {
  const fetchImpl = async () => jsonResponse({ message: "Bad credentials" }, 401);
  await assert.rejects(
    listAllReleases({ owner: "TheZan", repo: "Fjord", token: "t", fetchImpl }),
    /GitHub API error 401/,
  );
});

test("listReleaseAssets paginates the same way", async () => {
  const pageSize = 2;
  const allAssets = [{ id: 10, name: "a.exe" }, { id: 11, name: "b.dmg" }, { id: 12, name: "latest.json" }];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const start = (page - 1) * pageSize;
    return jsonResponse(allAssets.slice(start, start + pageSize));
  };

  const assets = await listReleaseAssets({ owner: "TheZan", repo: "Fjord", token: "t", releaseId: 1, fetchImpl, perPage: pageSize });
  assert.deepEqual(assets, allAssets);
});

test("deleteReleaseAsset resolves without error on 204", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return { ok: false, status: 204, text: async () => "" };
  };
  await deleteReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 42, fetchImpl });
  assert.equal(calls[0].method, "DELETE");
  assert.match(calls[0].url, /releases\/assets\/42$/);
});

test("deleteReleaseAsset throws on a real error status", async () => {
  const fetchImpl = async () => jsonResponse({ message: "not found" }, 404);
  await assert.rejects(
    deleteReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 42, fetchImpl }),
    /GitHub API error 404/,
  );
});

test("publishRelease PATCHes the release by id with draft/prerelease false", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return jsonResponse({ id: 7, draft: false, prerelease: false });
  };
  const result = await publishRelease({ owner: "TheZan", repo: "Fjord", token: "t", releaseId: 7, fetchImpl });
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /releases\/7$/);
  assert.deepEqual(calls[0].body, { draft: false, prerelease: false });
  assert.equal(result.draft, false);
});

// --- downloadReleaseAsset ------------------------------------------------
//
// This is the fix for release #4's failure: `browser_download_url` 404s for
// a draft release's assets (GitHub reports them under an ephemeral
// `untagged-*` path until the release is published), so downloading
// `latest.json` for verification has to go through the authenticated
// asset-ID endpoint with `Accept: application/octet-stream` instead.

function binaryResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => Buffer.from(bytes).toString("utf8"),
  };
}

test("downloadReleaseAsset sends a Bearer Authorization header", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return binaryResponse(Buffer.from("{}"));
  };
  await downloadReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "secret-token", assetId: 99, fetchImpl });
  assert.equal(calls[0].headers.Authorization, "Bearer secret-token");
});

test("downloadReleaseAsset asks for application/octet-stream, not the default JSON metadata", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return binaryResponse(Buffer.from("{}"));
  };
  await downloadReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 99, fetchImpl });
  assert.equal(calls[0].headers.Accept, "application/octet-stream");
  assert.match(calls[0].url, /releases\/assets\/99$/);
});

test("downloadReleaseAsset throws with a clear message on an API failure (e.g. the old 404)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "Not Found" });
  await assert.rejects(
    downloadReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 99, fetchImpl }),
    /GitHub API error 404/,
  );
});

test("downloadReleaseAsset returns the exact bytes for a text (JSON) asset", async () => {
  const json = JSON.stringify({ version: "0.1.0", platforms: {} });
  const fetchImpl = async () => binaryResponse(Buffer.from(json, "utf8"));
  const buffer = await downloadReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 99, fetchImpl });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString("utf8"), json);
});

test("downloadReleaseAsset returns the exact bytes for a binary asset", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
  const fetchImpl = async () => binaryResponse(bytes);
  const buffer = await downloadReleaseAsset({ owner: "TheZan", repo: "Fjord", token: "t", assetId: 99, fetchImpl });
  assert.deepEqual(buffer, bytes);
});
