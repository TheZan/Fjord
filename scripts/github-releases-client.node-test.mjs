import assert from "node:assert/strict";
import test from "node:test";

import { deleteReleaseAsset, listAllReleases, listReleaseAssets, publishRelease } from "./github-releases-client.mjs";

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
