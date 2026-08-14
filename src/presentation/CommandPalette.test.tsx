import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, paletteScore, type PaletteItem } from "@/presentation/CommandPalette";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function item(id: string, label: string, detail = "", run: PaletteItem["run"] = vi.fn()): PaletteItem {
  return { id, label, detail, run };
}

describe("CommandPalette", () => {
  it.each([
    ["", "Open repository", "", 0],
    ["repo", "Open repository", "", 5],
    ["oprp", "Open repository", "", 1004],
    ["xyz", "Open repository", "", null],
    ["OPEN", "Open repository", "", 0],
  ])("scores %j against a label", (query, label, detail, expected) => {
    expect(paletteScore(query, label, detail)).toBe(expected);
  });

  it("ranks matching actions, excludes misses, and shows scope groups", () => {
    render(
      <CommandPalette
        items={[
          { ...item("late", "Repository opener", "repo"), group: "Repository" },
          { ...item("first", "Repo settings"), group: "Global" },
          item("miss", "Fetch all"),
        ]}
        query="repo"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Repository openerrepocommandPalette.action",
      "Repo settingscommandPalette.action",
    ]);
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.queryByText("Fetch all")).not.toBeInTheDocument();
  });

  it("navigates with the keyboard and closes before running the selected item", () => {
    const calls: string[] = [];
    const first = item("first", "First", "", () => { calls.push("first"); });
    const second = item("second", "Second", "", () => { calls.push("second"); });
    const onClose = vi.fn(() => calls.push("close"));
    render(
      <CommandPalette
        items={[first, second]}
        query=""
        onQueryChange={vi.fn()}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(calls).toEqual(["close", "second"]);
    expect(screen.getByRole("button", { name: /Second/ })).toHaveAttribute("data-selected", "true");
  });

  it("closes on Escape and caps results at twelve", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        items={Array.from({ length: 13 }, (_, index) => item(`local-${index}`, `Local ${index}`))}
        query=""
        onQueryChange={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(12);
    expect(screen.getByText("Local 11")).toBeInTheDocument();
    expect(screen.queryByText("Local 12")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
