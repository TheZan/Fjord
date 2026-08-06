import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, CommitSummary, TagInfo } from "@/domain/git";
import { CommitGraph } from "@/presentation/CommitGraph";

const graphState = vi.hoisted(() => ({
  branches: [] as BranchInfo[],
  commits: [] as CommitSummary[],
  tags: [] as TagInfo[],
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 30,
        start: index * 30,
      })),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: Record<string, number>) =>
      values && "count" in values ? `${key}:${values.count}` : key,
  }),
}));

vi.mock("@/application/useBranches", () => ({
  useBranches: () => ({ branches: graphState.branches, error: null, loading: false }),
}));

vi.mock("@/application/useCommitLog", () => ({
  useCommitLog: () => ({
    commits: graphState.commits,
    error: null,
    hasMore: false,
    loadMore: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/application/useCommitSearch", () => ({
  useCommitSearch: () => ({ commits: [], error: null, loading: false }),
}));

vi.mock("@/application/useTags", () => ({
  useTags: () => ({ tags: graphState.tags, error: null, loading: false }),
}));

describe("CommitGraph", () => {
  beforeEach(() => {
    graphState.branches = [];
    graphState.commits = [];
    graphState.tags = [];
    Element.prototype.scrollTo = vi.fn();
  });

  it("shows branch and tag badges from their target commits when log refs are empty", () => {
    graphState.commits = [
      {
        id: "commit-1",
        parentIds: [],
        message: "Feature tip",
        authorName: "Fjord",
        authorEmail: "fjord@example.com",
        authoredAt: "2026-08-06T10:00:00Z",
        refs: [],
      },
    ];
    graphState.branches = [
      {
        name: "develop",
        isCurrent: true,
        isRemote: false,
        upstream: null,
        targetCommitId: "commit-1",
      },
    ];
    graphState.tags = [{ name: "v1.0.0", targetCommitId: "commit-1" }];

    render(<CommitGraph repoId="repo-1" currentBranch="develop" />);

    expect(screen.getByText("develop")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });
});
