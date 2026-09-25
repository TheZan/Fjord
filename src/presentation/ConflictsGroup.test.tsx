import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "@/infrastructure/i18n";
import { ConflictsGroup, conflictMenuItems } from "@/presentation/ConflictsGroup";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import type { ConflictEntry, ConflictSet, ConflictSides } from "@/domain/git";
import type { WorkingFileSelectionController } from "@/application/useWorkingFileSelection";

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: vi.fn(async () => ({ repo: { fileViewMode: "path" } })),
  saveRepoModes: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    scrollToIndex: vi.fn(),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      size: 29,
      start: index * 29,
    })),
  }),
}));

const generations = { workingTree: 4, refs: 2, history: 2, stash: 0, config: 0 };
const stage = (blob: string) => ({ blob, mode: 0o100644, size: 10, binary: false });
const mergeSides: ConflictSides = { oursLabel: "main", theirsLabel: "feature/payments", inverted: false };

function entry(path: string, kind: ConflictEntry["kind"]): ConflictEntry {
  const has = {
    bothModified: [true, true, true],
    bothAdded: [false, true, true],
    addedByUs: [false, true, false],
    addedByThem: [false, false, true],
    deletedByUs: [true, false, true],
    deletedByThem: [true, true, false],
    bothDeleted: [true, false, false],
  }[kind];
  return {
    path,
    kind,
    base: has[0] ? stage("b") : null,
    ours: has[1] ? stage("o") : null,
    theirs: has[2] ? stage("t") : null,
  };
}

function set(entries: ConflictEntry[], sides = mergeSides): ConflictSet {
  return { entries, truncated: false, total: entries.length, sides, generations };
}

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, { ns: "workspace", ...values });

function menuLabels(conflictEntry: ConflictEntry, sides = mergeSides) {
  return conflictMenuItems(conflictEntry, sides, false, t as never).map((item) => item.label);
}

function openMenu(path: string) {
  const row = screen.getByRole("option", { name: new RegExp(path.slice(path.lastIndexOf("/") + 1).replace(".", "\\.")) });
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.getByRole("menu", { name: path });
}

function selection(): WorkingFileSelectionController {
  return {
    targets: new Set(),
    active: null,
    source: null,
    selectedPaths: () => new Set(),
    select: vi.fn(),
    activate: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    registerVisibleTargets: vi.fn(),
    prepareContextMenu: vi.fn(),
    beginSourceRemap: vi.fn(() => false),
    completeSourceRemap: vi.fn(),
  } as unknown as WorkingFileSelectionController;
}

function panel(conflicts: ConflictSet | null) {
  return (
    <WorkingChangesPanel
      changes={{
        unstaged: [{ path: "src/pay.ts", changeType: "modified", tracked: true, conflicted: true }],
        staged: [],
      }}
      loading={false}
      error={null}
      busy={false}
      validated
      selection={selection()}
      onStage={vi.fn()}
      onUnstage={vi.fn()}
      onSelectionAction={vi.fn()}
      onPrepareAmend={vi.fn(async () => null)}
      onCommit={vi.fn(async () => true)}
      conflicts={conflicts}
      onResolveConflict={vi.fn()}
    />
  );
}

beforeAll(() => {
  initI18n("en");
});

describe("ConflictsGroup (conflict-resolution.md §6)", () => {
  // Component case 1.
  it("renders one row per entry with its localized kind, and nothing for a clean index", async () => {
    const conflicts = set([
      entry("src/pay.ts", "bothModified"),
      entry("src/gone.ts", "deletedByThem"),
      entry("docs/new.md", "addedByThem"),
    ]);
    const { container, rerender } = render(panel(conflicts));

    const group = screen.getByRole("region", { name: "Conflicts" });
    const rows = within(group).getAllByRole("option");
    expect(rows).toHaveLength(3);
    expect(within(group).getByText("Conflicts (3)")).toBeInTheDocument();
    expect(within(group).getByText("changed on both sides")).toBeInTheDocument();
    expect(within(group).getByText("changed on main, deleted on feature/payments")).toBeInTheDocument();
    expect(within(group).getByText("added only on feature/payments")).toBeInTheDocument();
    expect((await axe.run(group, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);

    rerender(panel(set([])));
    expect(screen.queryByRole("region", { name: "Conflicts" })).not.toBeInTheDocument();
    rerender(panel(null));
    expect(screen.queryByTestId("conflicts-group")).not.toBeInTheDocument();
    expect(container).toBeTruthy();
  });

  // Component case 2.
  it("names each side by its real ref, and states the rebase inversion", () => {
    expect(menuLabels(entry("a.ts", "bothModified")).slice(0, 2)).toEqual([
      "Keep main version",
      "Keep feature/payments version",
    ]);

    const rebase: ConflictSides = { oursLabel: "main", theirsLabel: "topic", inverted: true };
    render(
      <ConflictsGroup
        conflicts={set([entry("a.ts", "bothModified")], rebase)}
        busy={false}
        markerWarning={null}
        onResolve={vi.fn()}
        onFileAction={vi.fn()}
        onDismissMarkerWarning={vi.fn()}
      />,
    );
    expect(screen.getByText(
      "Rebase in progress: main is the branch being rebased onto, and topic is the commit being replayed.",
    )).toBeInTheDocument();
    const menu = openMenu("a.ts");
    // During a rebase Git's `--ours` is the onto-branch: the first take-side
    // entry keeps `main`, labelled as such, never as a side word.
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
      expect.arrayContaining(["Keep main version", "Keep topic version"]),
    );
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item.textContent ?? "").not.toMatch(/\b(ours|theirs)\b/i);
    }
  });

  // Component case 3.
  it("omits a kind's inapplicable resolutions from its menu", () => {
    const ids = (kind: ConflictEntry["kind"]) =>
      conflictMenuItems(entry("a.ts", kind), mergeSides, false, t as never)
        .map((item) => item.id)
        .filter((id) => id.startsWith("resolve:"));
    expect(ids("bothModified")).toEqual(["resolve:takeOurs", "resolve:takeTheirs", "resolve:markResolved"]);
    expect(ids("bothAdded")).toEqual(["resolve:takeOurs", "resolve:takeTheirs", "resolve:markResolved"]);
    for (const kind of ["addedByUs", "addedByThem", "deletedByUs", "deletedByThem"] as const) {
      expect(ids(kind)).toEqual(["resolve:keepFile", "resolve:deleteFile"]);
    }
    expect(ids("bothDeleted")).toEqual(["resolve:deleteFile"]);
    expect(menuLabels(entry("a.ts", "deletedByThem"))[0]).toBe("Keep the file from main");
    expect(menuLabels(entry("a.ts", "deletedByUs"))[0]).toBe("Keep the file from feature/payments");
  });

  // Component case 4 (component half; the container half re-dispatches from a real error).
  it("renders the marker reason with Stage anyway, which re-dispatches with the acknowledgement", async () => {
    const onResolve = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(
      <ConflictsGroup
        conflicts={set([entry("src/pay.ts", "bothModified")])}
        busy={false}
        markerWarning={{ path: "src/pay.ts", line: 12 }}
        onResolve={onResolve}
        onFileAction={vi.fn()}
        onDismissMarkerWarning={onDismiss}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("src/pay.ts still contains conflict markers at line 12.");
    fireEvent.click(within(alert).getByRole("button", { name: "Stage anyway" }));
    expect(onResolve).toHaveBeenCalledWith("src/pay.ts", "markResolved", true);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  // Component case 5 (conflict row half; the Unstaged row half is in WorkingFileContextMenu.test).
  it("keeps Stage and Discard visible but disabled on a conflicted row, naming the conflict", () => {
    const items = conflictMenuItems(entry("src/pay.ts", "bothModified"), mergeSides, false, t as never);
    for (const id of ["stage", "discard"]) {
      expect(items.find((item) => item.id === id)).toMatchObject({
        disabled: true,
        disabledReason: "src/pay.ts has a conflict. Resolve it from the Conflicts group first.",
      });
    }
  });

  it("dispatches a resolution and the existing merge-tool handoff from the keyboard menu", () => {
    const onResolve = vi.fn();
    const onFileAction = vi.fn();
    render(
      <ConflictsGroup
        conflicts={set([entry("src/pay.ts", "bothModified"), entry("src/gone.ts", "deletedByThem")])}
        busy={false}
        markerWarning={null}
        onResolve={onResolve}
        onFileAction={onFileAction}
        onDismissMarkerWarning={vi.fn()}
      />,
    );

    const row = screen.getByRole("option", { name: /gone\.ts/ });
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "src/gone.ts" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete file" }));
    expect(onResolve).toHaveBeenCalledWith("src/gone.ts", "deleteFile", false);

    fireEvent.click(within(openMenu("src/pay.ts")).getByRole("menuitem", { name: "Open merge tool" }));
    expect(onFileAction).toHaveBeenCalledWith("openMergeTool", "src/pay.ts");
    fireEvent.click(within(openMenu("src/pay.ts")).getByRole("menuitem", { name: "Keep feature/payments version" }));
    expect(onResolve).toHaveBeenCalledWith("src/pay.ts", "takeTheirs", false);
  });

  it("reports a truncated set with its exact total", () => {
    render(
      <ConflictsGroup
        conflicts={{ ...set([entry("a.ts", "bothModified")]), truncated: true, total: 1204 }}
        busy={false}
        markerWarning={null}
        onResolve={vi.fn()}
        onFileAction={vi.fn()}
        onDismissMarkerWarning={vi.fn()}
      />,
    );
    expect(screen.getByText("Showing 1 of 1204 conflicted files. Use the merge tool for the rest.")).toBeInTheDocument();
  });
});
