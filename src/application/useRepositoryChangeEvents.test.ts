import { describe, expect, it } from "vitest";
import { repositoryChangeScopes } from "@/application/useRepositoryChangeEvents";

describe("repositoryChangeScopes", () => {
  it("maps only affected repository data", () => {
    expect(
      repositoryChangeScopes({
        repoId: "repo-1",
        status: true,
        working: false,
        history: true,
        refs: true,
        stashes: false,
        statusSummary: null,
      }),
    ).toEqual(["status", "history", "refs"]);
  });
});
