import { describe, expect, it } from "vitest";
import { filterRepositoryRows } from "@/application/repoHealth";
import type { RepoHealth } from "@/domain/workspace";

describe("ws-100 workspace health filtering", () => {
  it("filters 100 loaded repositories to Wrong branch comfortably in-process", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      workspace: { name: "ws-100" },
      repo: { id: `repo-${index}`, name: `Repository ${index}`, path: `/ws-100/repo-${index}` },
    }));
    const healthByRepo = Object.fromEntries(
      rows.map(({ repo }, index) => [
        repo.id,
        {
          repoId: repo.id,
          conditions:
            index % 10 === 0
              ? [{ kind: "wrongBranch" as const, expected: "develop", actual: index === 0 ? null : "feature/x" }]
              : [{ kind: "clean" as const }],
          needsAttention: index % 10 === 0,
          asOf: "1970-01-01T00:00:00Z",
        } satisfies RepoHealth,
      ]),
    );

    const samples: number[] = [];
    let filtered = rows;
    for (let index = 0; index < 2_000; index += 1) {
      const started = performance.now();
      filtered = filterRepositoryRows(rows, healthByRepo, new Set(["wrongBranch"]), "");
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const max = samples[samples.length - 1];
    console.info(`p10-10-ws-100-filter-ms p50=${p50.toFixed(3)} p95=${p95.toFixed(3)} max=${max.toFixed(3)}`);

    expect(filtered).toHaveLength(10);
    expect(filtered[0].repo.id).toBe("repo-0");
    expect(p95).toBeLessThan(5);
  });
});
