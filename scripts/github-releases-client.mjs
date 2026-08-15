// Thin fetch-based GitHub REST client for the release-discovery scripts —
// the only place in this workflow's tooling that makes network calls for
// release lookup, so `release-discovery-lib.mjs` can stay pure and testable.
// `fetchImpl` is injectable so tests can supply a fake paginating fetch
// without touching the network; it defaults to Node's built-in global
// `fetch` (stable since Node 18, and every workflow step already runs
// Node 22).

// Overridable only so CLI-level tests can point this at a local mock server
// instead of the real GitHub API — production code paths never set this.
const GITHUB_API_BASE = process.env.FJORD_GITHUB_API_BASE || "https://api.github.com";
const DEFAULT_PER_PAGE = 100;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fjord-release-workflow",
  };
}

async function assertOk(response, description) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status} ${description}: ${body}`);
  }
}

/** Every release in the repo, across all pages — includes drafts (unlike get-by-tag). */
export async function listAllReleases({ owner, repo, token, fetchImpl = fetch, perPage = DEFAULT_PER_PAGE }) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=${perPage}&page=${page}`;
    const response = await fetchImpl(url, { headers: authHeaders(token) });
    await assertOk(response, `listing releases (page ${page})`);
    const body = await response.json();
    releases.push(...body);
    if (body.length < perPage) break;
  }
  return releases;
}

/** Every asset on one release, across all pages. */
export async function listReleaseAssets({ owner, repo, token, releaseId, fetchImpl = fetch, perPage = DEFAULT_PER_PAGE }) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`;
    const response = await fetchImpl(url, { headers: authHeaders(token) });
    await assertOk(response, `listing assets for release ${releaseId} (page ${page})`);
    const body = await response.json();
    assets.push(...body);
    if (body.length < perPage) break;
  }
  return assets;
}

export async function deleteReleaseAsset({ owner, repo, token, assetId, fetchImpl = fetch }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/assets/${assetId}`;
  const response = await fetchImpl(url, { method: "DELETE", headers: authHeaders(token) });
  if (!response.ok && response.status !== 204) {
    await assertOk(response, `deleting asset ${assetId}`);
  }
}

/** Publishes by release ID, not by re-resolving the tag — avoids a TOCTOU gap between verify and publish. */
export async function publishRelease({ owner, repo, token, releaseId, fetchImpl = fetch }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/${releaseId}`;
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false, prerelease: false }),
  });
  await assertOk(response, `publishing release ${releaseId}`);
  return response.json();
}
