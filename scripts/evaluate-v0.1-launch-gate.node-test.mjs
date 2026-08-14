import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLaunchGate,
  READY_DECISION,
  REQUIRED_CONDITION_IDS,
} from "./v0.1-launch-gate-lib.mjs";

function passingManifest() {
  return {
    schema_version: 1,
    conditions: REQUIRED_CONDITION_IDS.map((id) => ({
      id,
      status: "pass",
      evidence: [{ href: `https://example.test/${id}`, note: `${id} evidence` }],
    })),
  };
}

test("returns the exact ready decision only when every condition passes", () => {
  const result = evaluateLaunchGate(passingManifest());

  assert.equal(result.ready, true);
  assert.equal(result.decision, READY_DECISION);
  assert.deepEqual(result.blockers, []);
});

test("reports every blocker in manifest order", () => {
  const manifest = passingManifest();
  manifest.conditions[2].status = "blocked";
  manifest.conditions[2].blocker = "candidate data-loss review is missing";
  manifest.conditions[4].status = "blocked";
  manifest.conditions[4].blocker = "signed artifacts are missing";

  const result = evaluateLaunchGate(manifest);

  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, [
    "candidate data-loss review is missing",
    "signed artifacts are missing",
  ]);
  assert.equal(
    result.decision,
    "BLOCKED: candidate data-loss review is missing; signed artifacts are missing",
  );
});

test("fails closed for missing, malformed, duplicate, and unknown evidence", () => {
  const manifest = passingManifest();
  manifest.conditions.shift();
  manifest.conditions[0].evidence = [];
  manifest.conditions.push({ ...manifest.conditions[1] });
  manifest.conditions.push({
    id: "unreviewed_extra",
    status: "pass",
    evidence: [{ href: "evidence", note: "unexpected" }],
  });

  const result = evaluateLaunchGate(manifest);

  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("phase9_safety_recovery evidence is missing"));
  assert.ok(result.blockers.includes("onboarding_essentials has no reviewable evidence link"));
  assert.ok(result.blockers.includes("launch evidence condition no_known_data_loss is duplicated"));
  assert.ok(result.blockers.includes("unexpected launch evidence condition unreviewed_extra"));
});
