import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableRepoLayout } from "@/presentation/ResizableRepoLayout";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("ResizableRepoLayout", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1400,
      height: 700,
      top: 0,
      right: 1400,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resizes a pane from the keyboard and persists the result", () => {
    renderLayout();

    const separator = screen.getByRole("separator", { name: "Resize repository tree" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator).toHaveAttribute("aria-valuenow", "252");
    expect(JSON.parse(localStorage.getItem("fjord:repo-layout:v1") ?? "{}")).toMatchObject({
      left: 252,
    });
  });

  it("shows the inspector as a dismissible drawer in compact mode", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900,
      height: 700,
      top: 0,
      right: 900,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const onClose = vi.fn();

    renderLayout({ rightOpen: true, onCloseRight: onClose });
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderLayout({
  rightOpen = false,
  onCloseRight = vi.fn(),
}: {
  rightOpen?: boolean;
  onCloseRight?: () => void;
} = {}) {
  return render(
    <ResizableRepoLayout
      left={<div>Tree</div>}
      center={<div>Graph</div>}
      right={<div>Details</div>}
      rightOpen={rightOpen}
      rightLabel="Inspector"
      closeLabel="Close inspector"
      onCloseRight={onCloseRight}
    />,
  );
}
