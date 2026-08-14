import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResizableSidebar } from "@/presentation/ResizableSidebar";

const loadUiState = vi.fn();
const saveSidebarWidth = vi.fn();

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveSidebarWidth: (...args: unknown[]) => saveSidebarWidth(...args),
}));

describe("ResizableSidebar", () => {
  it("restores its persisted width and saves keyboard resize end", async () => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: 300, collapsedWorkspaces: [] },
      repo: { treeWidth: 240, inspectorWidth: 384, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    saveSidebarWidth.mockResolvedValue(undefined);
    render(
      <ResizableSidebar resizeLabel="Resize sidebar">
        <aside>Navigation</aside>
      </ResizableSidebar>,
    );
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "300"));
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "312");
    expect(saveSidebarWidth).toHaveBeenCalledWith(312);
  });
});
