import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkReport,
  renderMarkdown,
} from "./report-benchmark-deltas.mjs";

function record(value, overrides = {}) {
  return {
    schemaVersion: 2,
    scenario: "status-noisy-tree",
    fixture: { kind: "working-tree", hash: "fixture-1", generated: false },
    environment: { os: "linux", arch: "x86_64", cpu: "CI", profile: "release" },
    cacheState: "warm",
    sampling: { warmups: 3, repetitions: 20 },
    metrics: {
      status: { value, unit: "ms", samples: 20, p50: value - 5, p95: value, max: value + 5 },
      files: { value: 50_000, unit: "count" },
    },
    budgets: [],
    ...overrides,
  };
}

test("a deliberately slowed result produces a visible positive delta", () => {
  const report = buildBenchmarkReport(
    [{ record: record(125) }],
    [{ record: record(100) }],
    { generatedAt: "2026-08-10T00:00:00.000Z" },
  );
  const markdown = renderMarkdown(report);

  assert.equal(report.comparisons[0].metrics[0].percent, 25);
  assert.match(markdown, /status \(p95\).*125\.000 ms.*100\.000 ms.*\+25\.0%/);
  assert.doesNotMatch(markdown, /files/);
});

test("an absent baseline is reported without inventing a comparison", () => {
  const report = buildBenchmarkReport([{ record: record(100) }], [], {
    generatedAt: "2026-08-10T00:00:00.000Z",
  });

  assert.equal(report.comparisons[0].status, "no_baseline");
  assert.match(renderMarkdown(report), /no previous baseline/);
});

test("different sampling settings are visible and not compared", () => {
  const current = record(125);
  const baseline = record(100, { sampling: { warmups: 0, repetitions: 1 } });
  const report = buildBenchmarkReport(
    [{ record: current }],
    [{ record: baseline }],
    { generatedAt: "2026-08-10T00:00:00.000Z" },
  );

  assert.equal(report.comparisons[0].status, "not_comparable");
  assert.deepEqual(report.comparisons[0].reasons, ["warmups: 3 vs 0", "repetitions: 20 vs 1"]);
  assert.match(renderMarkdown(report), /not comparable: warmups: 3 vs 0; repetitions: 20 vs 1/);
});
