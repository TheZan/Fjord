import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEntryList, type FileTreeCollapse } from "@/presentation/FileEntryList";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    scrollToIndex: vi.fn(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 3) }, (_, index) => ({
        index,
        key: index,
        size: 29,
        start: index * 29,
      })),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FileEntryList", () => {
  afterEach(cleanup);

  it("renders only virtual rows for a large file list", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts` }));
    const onSelect = vi.fn();

    render(
      <FileEntryList
        files={files}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set()}
        activePath={null}
        onSelect={onSelect}
        renderMark={() => "M"}
      />,
    );

    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByText("file-99.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("file-1.ts"));
    expect(onSelect).toHaveBeenCalledWith(files[1], { toggle: false, range: false }, files);
  });

  it("constrains a long file name to the available row width", () => {
    const path = `src/generated/${"LongTypeName".repeat(12)}.Designer.cs`;

    render(
      <FileEntryList
        files={[{ path }]}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set()}
        activePath={null}
        onSelect={vi.fn()}
        renderMark={() => "M"}
        renderTrailing={() => <span>+10 -2</span>}
      />,
    );

    const row = screen.getByTitle(path);
    const fileName = screen.getByText(`${"LongTypeName".repeat(12)}.Designer.cs`);
    expect(row).toHaveClass("min-w-0", "overflow-hidden");
    expect(fileName).toHaveClass("min-w-0", "flex-1", "truncate");
  });

  it("forwards identical logical file identity for pointer and keyboard context menus", () => {
    const file = { path: "src/app.ts" };
    const onSelect = vi.fn();
    const onFileContextMenu = vi.fn();
    render(
      <FileEntryList
        files={[file]}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set()}
        activePath={null}
        onSelect={onSelect}
        onFileContextMenu={onFileContextMenu}
        renderMark={() => "M"}
      />,
    );
    const row = screen.getByTitle(file.path);

    fireEvent.contextMenu(row, { clientX: 42, clientY: 57 });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onFileContextMenu.mock.calls.map(([target]) => target)).toEqual([file, file, file]);
    expect(onFileContextMenu).toHaveBeenNthCalledWith(1, file, { x: 42, y: 57 });
    expect(row).toHaveFocus();
  });

  it("does not expose the file context seam on a tree directory row", () => {
    const onFileContextMenu = vi.fn();
    render(
      <FileEntryList
        files={[{ path: "src/app.ts" }]}
        mode="tree"
        collapse={emptyCollapse()}
        selectedPaths={new Set()}
        activePath={null}
        onSelect={vi.fn()}
        onFileContextMenu={onFileContextMenu}
        renderMark={() => "M"}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /src/ }));
    expect(onFileContextMenu).not.toHaveBeenCalled();
  });

  it("reports desktop modifiers without owning selection state", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    const onSelect = vi.fn();
    render(
      <FileEntryList
        files={files}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set()}
        activePath="a.ts"
        onSelect={onSelect}
        renderMark={() => "M"}
      />,
    );

    fireEvent.click(screen.getByTitle("a.ts"), { ctrlKey: true });
    fireEvent.click(screen.getByTitle("b.ts"), { metaKey: true, shiftKey: true });

    expect(onSelect).toHaveBeenNthCalledWith(1, files[0], { toggle: true, range: false }, files);
    expect(onSelect).toHaveBeenNthCalledWith(2, files[1], { toggle: true, range: true }, files);
  });

  it("implements arrows, Shift+Arrow, primary+Space, Escape, and section Select All", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
    const onSelect = vi.fn();
    const onSelectAll = vi.fn();
    render(
      <FileEntryList
        files={files}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set(["b.ts"])}
        activePath="b.ts"
        onSelect={onSelect}
        onSelectAll={onSelectAll}
        renderMark={() => "M"}
      />,
    );
    const row = screen.getByTitle("b.ts");

    fireEvent.keyDown(row, { key: "ArrowDown" });
    fireEvent.keyDown(row, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(row, { key: " ", ctrlKey: true });
    fireEvent.keyDown(row, { key: "Escape" });
    fireEvent.keyDown(row, { key: "a", code: "KeyA", ctrlKey: true });

    expect(onSelect).toHaveBeenNthCalledWith(1, files[2], { toggle: false, range: false }, files);
    expect(onSelect).toHaveBeenNthCalledWith(2, files[0], { toggle: false, range: true }, files);
    expect(onSelect).toHaveBeenNthCalledWith(
      3,
      files[1],
      { toggle: true, range: false, preserveAnchor: true },
      files,
    );
    expect(onSelect).toHaveBeenNthCalledWith(4, files[1], { toggle: false, range: false }, files);
    expect(onSelectAll).toHaveBeenCalledWith(files, files[1]);
  });

  it("exposes multiselect listbox semantics and a roving tabindex", () => {
    render(
      <FileEntryList
        files={[{ path: "a.ts" }, { path: "b.ts" }]}
        mode="path"
        collapse={emptyCollapse()}
        selectedPaths={new Set(["a.ts", "b.ts"])}
        activePath="b.ts"
        onSelect={vi.fn()}
        renderMark={() => "M"}
        multiselectable
        ariaLabel="Unstaged"
      />,
    );

    expect(screen.getByRole("listbox", { name: "Unstaged" })).toHaveAttribute(
      "aria-multiselectable",
      "true",
    );
    expect(screen.getByTitle("a.ts")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("a.ts")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTitle("b.ts")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("b.ts")).toHaveAttribute("tabindex", "0");
  });

  it("reports only visible files in Tree view and never makes directories selectable", () => {
    const onVisibleFilesChange = vi.fn();
    render(
      <FileEntryList
        files={[{ path: "root.ts" }, { path: "src/a.ts" }, { path: "src/b.ts" }]}
        mode="tree"
        collapse={{ ...emptyCollapse(), collapsed: new Set(["src"]) }}
        selectedPaths={new Set()}
        activePath={null}
        onSelect={vi.fn()}
        onVisibleFilesChange={onVisibleFilesChange}
        renderMark={() => "M"}
        multiselectable
      />,
    );

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /src/ })).not.toHaveAttribute("aria-selected");
    expect(onVisibleFilesChange).toHaveBeenLastCalledWith([{ path: "root.ts" }]);
  });
});

function emptyCollapse(): FileTreeCollapse {
  return {
    collapsed: new Set(),
    toggle: vi.fn(),
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
    hasDirectories: false,
    allCollapsed: false,
  };
}
