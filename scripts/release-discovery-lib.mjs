// Pure release-selection/candidate-safety logic — no network I/O, so this is
// fully unit-testable with fixture release objects. See
// `github-releases-client.mjs` for the paginated fetch that supplies the
// `releases` array these functions operate on.
//
// Why this exists: GitHub's "Get a release by tag name" endpoint
// (`GET /repos/{owner}/{repo}/releases/tags/{tag}`) is documented to return
// only a *published* release with that tag — never a draft. Every earlier
// revision of this workflow used that endpoint to find the intentionally
// still-draft release it had just created, and got a 404 for its trouble.
// The fix is to list every release (`GET /repos/{owner}/{repo}/releases`,
// which does include drafts) and select the one whose `tag_name` matches.

export function selectReleaseByTag(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) {
    throw new Error(
      `ambiguous: ${matches.length} releases have tag_name ${JSON.stringify(tag)} ` +
        `(ids: ${matches.map((release) => release.id).join(", ")}) — refusing to guess which one is the real candidate`,
    );
  }
  return matches[0] ?? null;
}

export function candidateMarker(sha) {
  return `<!-- fjord-candidate-sha: ${sha} -->`;
}

/**
 * @param {object} params
 * @param {{ id: number, draft: boolean, body?: string | null, html_url?: string } | null} params.release
 * @param {string} params.expectedSha
 * @returns {{ status: "no-release" | "same-candidate" | "different-candidate" | "published", ok: boolean, message: string }}
 */
export function evaluateCandidateSafety({ release, expectedSha }) {
  if (!release) {
    return { status: "no-release", ok: true, message: "No existing release for this tag; proceeding." };
  }

  if (release.draft === false) {
    return {
      status: "published",
      ok: false,
      message:
        `This tag already has a published release (${release.html_url ?? `id ${release.id}`}). ` +
        "This workflow will never overwrite a published release — bump the version instead.",
    };
  }

  const marker = candidateMarker(expectedSha);
  if (!release.body || !release.body.includes(marker)) {
    return {
      status: "different-candidate",
      ok: false,
      message:
        `A draft release for this tag already exists (${release.html_url ?? `id ${release.id}`}) but it does not carry ` +
        `the candidate marker for commit ${expectedSha} — it belongs to a different candidate SHA. Remove it ` +
        "intentionally (Releases → delete the draft) before retrying; see docs/releasing.md.",
    };
  }

  return {
    status: "same-candidate",
    ok: true,
    message: `Existing draft matches commit ${expectedSha}; safe to reuse — its assets will be cleared before this retry rebuilds them.`,
  };
}
