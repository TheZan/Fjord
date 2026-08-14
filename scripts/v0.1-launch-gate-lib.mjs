export const READY_DECISION = "READY FOR v0.1 PUBLIC EARLY PREVIEW";

export const REQUIRED_CONDITION_IDS = [
  "phase9_safety_recovery",
  "onboarding_essentials",
  "no_known_data_loss",
  "same_sha_ci",
  "signed_release_artifacts",
  "fresh_install_smoke",
  "public_materials",
  "issue_reporting",
  "secrets_private_content_audit",
  "default_branch_and_metadata",
  "visibility_human_control",
];

function hasEvidence(condition) {
  return (
    Array.isArray(condition.evidence) &&
    condition.evidence.length > 0 &&
    condition.evidence.every(
      (entry) =>
        entry &&
        typeof entry.href === "string" &&
        entry.href.trim().length > 0 &&
        typeof entry.note === "string" &&
        entry.note.trim().length > 0,
    )
  );
}

export function evaluateLaunchGate(manifest) {
  const blockers = [];
  if (!manifest || manifest.schema_version !== 1) {
    blockers.push("launch evidence schema is missing or unsupported");
  }

  const conditions = Array.isArray(manifest?.conditions) ? manifest.conditions : [];
  if (!Array.isArray(manifest?.conditions)) {
    blockers.push("launch evidence conditions are missing");
  }

  const byId = new Map();
  for (const condition of conditions) {
    if (!condition || typeof condition.id !== "string") {
      blockers.push("launch evidence contains a condition without an id");
      continue;
    }
    if (byId.has(condition.id)) {
      blockers.push(`launch evidence condition ${condition.id} is duplicated`);
      continue;
    }
    byId.set(condition.id, condition);
  }

  for (const id of REQUIRED_CONDITION_IDS) {
    const condition = byId.get(id);
    if (!condition) {
      blockers.push(`${id} evidence is missing`);
      continue;
    }
    if (!hasEvidence(condition)) {
      blockers.push(`${id} has no reviewable evidence link`);
    }
    if (condition.status === "blocked") {
      if (typeof condition.blocker === "string" && condition.blocker.trim().length > 0) {
        blockers.push(condition.blocker.trim());
      } else {
        blockers.push(`${id} is blocked without a recorded reason`);
      }
    } else if (condition.status !== "pass") {
      blockers.push(`${id} has invalid status ${JSON.stringify(condition.status)}`);
    }
  }

  for (const id of byId.keys()) {
    if (!REQUIRED_CONDITION_IDS.includes(id)) {
      blockers.push(`unexpected launch evidence condition ${id}`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    decision:
      uniqueBlockers.length === 0
        ? READY_DECISION
        : `BLOCKED: ${uniqueBlockers.join("; ")}`,
  };
}
