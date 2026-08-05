import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoCard } from "@/presentation/RepoCard";
import type { RepositoryEntry, RepoStatusSummary } from "@/domain/workspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "cardStatus.changes" ? `${values?.count ?? 0} changes` : key,
  }),
}));

const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: "workspace-1",
  name: "fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};

const dirtyStatus: RepoStatusSummary["status"] = {
  branch: "develop",
  ahead: 0,
  behind: 0,
  dirtyCount: 3,
  hasConflict: false,
};

describe("RepoCard", () => {
  it("renders repository status and dispatches select/remove actions", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();

    render(
      <RepoCard
        repo={repo}
        status={dirtyStatus}
        selected={false}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );

    screen.getByRole("button", { name: /fjord/i }).click();
    screen.getByRole("button", { name: "repositories.removeButton" }).click();

    expect(screen.getByText("cardStatus.dirty")).toBeInTheDocument();
    expect(screen.getByText("3 changes")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
