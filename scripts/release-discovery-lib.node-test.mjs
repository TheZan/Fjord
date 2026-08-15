import assert from "node:assert/strict";
import test from "node:test";

import { candidateMarker, evaluateCandidateSafety, selectReleaseByTag } from "./release-discovery-lib.mjs";

const TAG = "v0.1.0";
const SHA = "3e1f10c95fc1927d2e82331040d54c1468f583d5";

function draftRelease(overrides = {}) {
  return {
    id: 1,
    tag_name: TAG,
    draft: true,
    prerelease: true,
    body: `notes\n\n${candidateMarker(SHA)}\n`,
    html_url: "https://github.com/TheZan/Fjord/releases/tag/v0.1.0",
    ...overrides,
  };
}

// --- selectReleaseByTag -----------------------------------------------

test("no matching release -> null", () => {
  assert.equal(selectReleaseByTag([], TAG), null);
  assert.equal(selectReleaseByTag([{ tag_name: "v0.2.0", id: 9 }], TAG), null);
});

test("exactly one matching release -> returned", () => {
  const release = draftRelease();
  assert.equal(selectReleaseByTag([{ tag_name: "v0.2.0", id: 9 }, release], TAG), release);
});

test("more than one matching release -> throws (ambiguous, fail closed)", () => {
  const releases = [draftRelease({ id: 1 }), draftRelease({ id: 2 })];
  assert.throws(() => selectReleaseByTag(releases, TAG), /ambiguous/);
});

// --- evaluateCandidateSafety --------------------------------------------

test("no release exists -> proceeds", () => {
  const result = evaluateCandidateSafety({ release: null, expectedSha: SHA });
  assert.equal(result.status, "no-release");
  assert.equal(result.ok, true);
});

test("draft with the correct candidate marker -> same-candidate, safe to reuse", () => {
  const result = evaluateCandidateSafety({ release: draftRelease(), expectedSha: SHA });
  assert.equal(result.status, "same-candidate");
  assert.equal(result.ok, true);
});

test("draft with a different candidate marker -> different-candidate, fails closed", () => {
  const release = draftRelease({ body: `notes\n\n${candidateMarker("0000000000000000000000000000000000000000")}\n` });
  const result = evaluateCandidateSafety({ release, expectedSha: SHA });
  assert.equal(result.status, "different-candidate");
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(SHA));
});

test("draft with no body at all (predates the marker) -> different-candidate, fails closed", () => {
  const release = draftRelease({ body: null });
  const result = evaluateCandidateSafety({ release, expectedSha: SHA });
  assert.equal(result.status, "different-candidate");
  assert.equal(result.ok, false);
});

test("draft with an empty body -> different-candidate, fails closed", () => {
  const release = draftRelease({ body: "" });
  const result = evaluateCandidateSafety({ release, expectedSha: SHA });
  assert.equal(result.status, "different-candidate");
  assert.equal(result.ok, false);
});

test("published release for the tag -> published, never overwritten", () => {
  const release = draftRelease({ draft: false });
  const result = evaluateCandidateSafety({ release, expectedSha: SHA });
  assert.equal(result.status, "published");
  assert.equal(result.ok, false);
});

test("published takes precedence over marker checking", () => {
  // A published release with no matching marker must still report "published",
  // not "different-candidate" — the two failure modes need different remediation.
  const release = draftRelease({ draft: false, body: "no marker here" });
  const result = evaluateCandidateSafety({ release, expectedSha: SHA });
  assert.equal(result.status, "published");
});
