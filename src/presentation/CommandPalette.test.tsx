import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, paletteScore, type PaletteItem } from "@/presentation/CommandPalette";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function item(id: string, label: string, detail = "", run: PaletteItem["run"] = vi.fn()): PaletteItem {
  return { id, label, detail, kind: "Action", run };
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

  it("ranks local matches, excludes misses, and appends backend results", () => {
    render(
      <CommandPalette
        items={[
          item("late", "Repository opener", "repo"),
          item("first", "Repo settings"),
          item("miss", "Fetch all"),
        ]}
        remoteItems={[item("remote", "Remote commit")]}
        query="repo"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Repository openerrepoAction",
      "Repo settingsAction",
      "Remote commitAction",
    ]);
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

  it("closes on Escape and caps merged results at twelve", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        items={Array.from({ length: 11 }, (_, index) => item(`local-${index}`, `Local ${index}`))}
        remoteItems={[item("remote-1", "Remote 1"), item("remote-2", "Remote 2")]}
        query=""
        onQueryChange={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(12);
    expect(screen.getByText("Remote 1")).toBeInTheDocument();
    expect(screen.queryByText("Remote 2")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
