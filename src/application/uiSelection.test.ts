import { describe, expect, it } from "vitest";
import { resolveRestoredSelection } from "@/application/uiSelection";

const workspaces = [
  { id: "first", name: "First", sortOrder: 0, expectedBranch: null },
  { id: "second", name: "Second", sortOrder: 1, expectedBranch: null },
];
const repositories = {
  first: [{ id: "repo-1", workspaceId: "first", name: "One", path: "/one", sortOrder: 0 }],
  second: [{ id: "repo-2", workspaceId: "second", name: "Two", path: "/two", sortOrder: 0 }],
};

describe("resolveRestoredSelection", () => {
  it("restores a selection only when both ids still resolve", () => {
    expect(
      resolveRestoredSelection({ workspaceId: "second", repositoryId: "repo-2" }, workspaces, repositories),
    ).toEqual({ workspaceId: "second", repositoryId: "repo-2" });
  });

  it("falls back without an error when persisted ids were removed", () => {
    expect(
      resolveRestoredSelection({ workspaceId: "gone", repositoryId: "gone" }, workspaces, repositories),
    ).toEqual({ workspaceId: "first", repositoryId: null });
    expect(resolveRestoredSelection({ workspaceId: "gone", repositoryId: "gone" }, [], {})).toEqual({
      workspaceId: null,
      repositoryId: null,
    });
  });
});
