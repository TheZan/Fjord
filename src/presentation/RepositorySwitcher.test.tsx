import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  rankRepositorySwitcherItems,
  RepositorySwitcher,
  type RepositorySwitcherItem,
} from "@/presentation/RepositorySwitcher";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function item(overrides: Partial<RepositorySwitcherItem>): RepositorySwitcherItem {
  return {
    id: "repo:fjord",
    label: "Fjord",
    detail: "Workspace · /dev/fjord",
    kind: "repository",
    recency: 0,
    run: vi.fn(),
    ...overrides,
  };
}

describe("RepositorySwitcher", () => {
  it("orders matching destinations by recency before fuzzy score", () => {
    const fuzzyBest = item({ id: "best", label: "Fjord", recency: 1 });
    const recent = item({ id: "recent", label: "My Fjord", recency: 10 });
    expect(rankRepositorySwitcherItems([fuzzyBest, recent], "fjord")).toEqual([recent, fuzzyBest]);
  });

  it("contains only repository and workspace destinations", () => {
    render(
      <RepositorySwitcher
        items={[
          item({ id: "repo", kind: "repository" }),
          item({ id: "workspace", label: "Work", kind: "workspace", recency: 2 }),
        ]}
        query=""
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("repositorySwitcher.repository")).toBeInTheDocument();
    expect(screen.getByText("repositorySwitcher.workspace")).toBeInTheDocument();
    expect(screen.queryByText("commandPalette.action")).not.toBeInTheDocument();
  });

  it("closes before navigating to the keyboard-selected destination", () => {
    const calls: string[] = [];
    render(
      <RepositorySwitcher
        items={[
          item({ id: "first", run: () => { calls.push("first"); } }),
          item({ id: "second", label: "Second", run: () => { calls.push("second"); } }),
        ]}
        query=""
        onQueryChange={vi.fn()}
        onClose={() => calls.push("close")}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(calls).toEqual(["close", "second"]);
  });
});
