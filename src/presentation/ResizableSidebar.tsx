import { useEffect, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { loadUiState, saveSidebarWidth } from "@/infrastructure/uiState";

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const HANDLE_WIDTH = 5;

export function ResizableSidebar({ children, resizeLabel }: { children: ReactNode; resizeLabel: string }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    let mounted = true;
    void loadUiState()
      .then((state) => {
        if (mounted) setWidth(constrainWidth(state.sidebar.width ?? DEFAULT_WIDTH));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  function persist(requestedWidth: number) {
    const next = constrainWidth(requestedWidth);
    setWidth(next);
    void saveSidebarWidth(next).catch(() => undefined);
  }

  function beginResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const bodyCursor = document.body.style.cursor;
    const bodySelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      setWidth(constrainWidth(startWidth + moveEvent.clientX - startX));
    };
    const onEnd = (endEvent: globalThis.PointerEvent) => {
      persist(startWidth + endEvent.clientX - startX);
      document.body.style.cursor = bodyCursor;
      document.body.style.userSelect = bodySelection;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    persist(width + direction * (event.shiftKey ? 40 : 12));
  }

  return (
    <div className="flex h-full shrink-0" style={{ width }} data-sidebar-width={Math.round(width)}>
      <div className="min-w-0 flex-1">{children}</div>
      <div
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={onResizeKey}
        className="group flex h-full shrink-0 cursor-col-resize touch-none justify-center outline-none"
        style={{ width: HANDLE_WIDTH }}
      >
        <span
          className="w-px transition-colors group-hover:bg-[var(--fjord)] group-focus-visible:bg-[var(--fjord)]"
          style={{ background: "var(--hairline)" }}
        />
      </div>
    </div>
  );
}

function constrainWidth(width: number) {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH));
}
