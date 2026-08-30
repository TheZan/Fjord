import { describe, expect, it } from "vitest";
import type { RepoHealth } from "@/domain/workspace";
import {
  filterRepositoryRows,
  repoMatchesHealthFilter,
  repoMatchesHealthFilters,
  serializeHealthFilters,
} from "@/application/repoHealth";

function health(
  conditions: RepoHealth["conditions"],
  needsAttention = false,
): RepoHealth {
  return {
    repoId: "repo",
    conditions,
    needsAttention,
    asOf: "1970-01-01T00:00:00Z",
  };
}

describe("workspace health filters", () => {
  it("maps the complete filter set from authoritative RepoHealth", () => {
    expect(repoMatchesHealthFilter(health([{ kind: "dirty", count: 1 }]), "dirty")).toBe(true);
    expect(repoMatchesHealthFilter(health([{ kind: "ahead", count: 1 }]), "ahead")).toBe(true);
    expect(repoMatchesHealthFilter(health([{ kind: "behind", count: 1 }]), "behind")).toBe(true);
    expect(repoMatchesHealthFilter(health([{ kind: "conflict" }]), "conflicts")).toBe(true);
    expect(
      repoMatchesHealthFilter(
        health([{ kind: "wrongBranch", expected: "develop", actual: null }], true),
        "wrongBranch",
      ),
    ).toBe(true);
  });

  it("uses needsAttention directly so a dirty-only repository is not attention", () => {
    const dirtyOnly = health([{ kind: "dirty", count: 2 }], false);
    expect(repoMatchesHealthFilter(dirtyOnly, "dirty")).toBe(true);
    expect(repoMatchesHealthFilter(dirtyOnly, "attention")).toBe(false);
  });

  it("treats Diverged as attention, ahead, and behind", () => {
    const diverged = health([{ kind: "diverged", ahead: 2, behind: 3 }], true);
    expect(repoMatchesHealthFilter(diverged, "attention")).toBe(true);
    expect(repoMatchesHealthFilter(diverged, "ahead")).toBe(true);
    expect(repoMatchesHealthFilter(diverged, "behind")).toBe(true);
  });

  it("composes multiple health filters with OR and excludes missing health", () => {
    const dirtyAndWrong = health([
      { kind: "wrongBranch", expected: "develop", actual: "feature/x" },
      { kind: "dirty", count: 1 },
    ]);
    expect(repoMatchesHealthFilters(dirtyAndWrong, new Set(["dirty", "conflicts"]))).toBe(true);
    expect(repoMatchesHealthFilters(dirtyAndWrong, new Set(["ahead", "conflicts"]))).toBe(false);
    expect(repoMatchesHealthFilters(undefined, new Set(["dirty"]))).toBe(false);
    expect(repoMatchesHealthFilters(undefined, new Set())).toBe(true);
  });

  it("composes text search with health using AND", () => {
    const rows = [
      { workspace: { name: "Product" }, repo: { id: "fjord", name: "Fjord", path: "/fjord" } },
      { workspace: { name: "Product" }, repo: { id: "api", name: "BackendApi", path: "/api" } },
      { workspace: { name: "Docs" }, repo: { id: "docs", name: "FjordDocs", path: "/docs" } },
    ];
    const healthByRepo = {
      fjord: { ...health([{ kind: "dirty", count: 1 }]), repoId: "fjord" },
      api: { ...health([{ kind: "conflict" }], true), repoId: "api" },
      docs: { ...health([{ kind: "clean" }]), repoId: "docs" },
    };

    expect(filterRepositoryRows(rows, healthByRepo, new Set(["dirty"]), "fjord")).toEqual([
      rows[0],
    ]);
  });

  it("serializes filters in canonical order independent of click order", () => {
    expect(serializeHealthFilters(new Set(["wrongBranch", "dirty", "attention"]))).toEqual([
      "attention",
      "dirty",
      "wrongBranch",
    ]);
  });
});
