import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

const STORAGE_KEY = "fjord:repo-layout:v1";
const COMPACT_BREAKPOINT = 1080;
const MIN_CENTER_WIDTH = 420;
const HANDLE_WIDTH = 9;

const PANE_LIMITS = {
  left: { min: 190, max: 360, default: 240 },
  right: { min: 300, max: 520, default: 384 },
} as const;

type Pane = keyof typeof PANE_LIMITS;
type PaneSizes = Record<Pane, number>;

interface ResizableRepoLayoutProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  rightOpen: boolean;
  rightLabel: string;
  closeLabel: string;
  onCloseRight: () => void;
  onCompactChange?: (compact: boolean) => void;
}

export function ResizableRepoLayout({
  left,
  center,
  right,
  rightOpen,
  rightLabel,
  closeLabel,
  onCloseRight,
  onCompactChange,
}: ResizableRepoLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [sizes, setSizes] = useState<PaneSizes>(readPaneSizes);
  const compact = containerWidth < COMPACT_BREAKPOINT;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onCompactChange?.(compact);
  }, [compact, onCompactChange]);

  function resizePane(pane: Pane, requestedSize: number, persist = false) {
    setSizes((current) => {
      const nextSize = constrainPaneSize(pane, requestedSize, current, containerWidth, compact);
      const next = { ...current, [pane]: nextSize };
      if (persist) writePaneSizes(next);
      return next;
    });
  }

  function beginResize(pane: Pane, event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startSize = sizes[pane];
    const direction = pane === "left" ? 1 : -1;
    const bodyCursor = document.body.style.cursor;
    const bodySelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      resizePane(pane, startSize + (moveEvent.clientX - startX) * direction);
    };
    const onEnd = (endEvent: globalThis.PointerEvent) => {
      const finalSize = startSize + (endEvent.clientX - startX) * direction;
      resizePane(pane, finalSize, true);
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

  function handleResizeKey(pane: Pane, event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const paneDirection = pane === "left" ? direction : -direction;
    resizePane(pane, sizes[pane] + paneDirection * (event.shiftKey ? 40 : 12), true);
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: sizes.left }}>
        {left}
      </div>
      <ResizeHandle
        label="Resize repository tree"
        value={sizes.left}
        min={PANE_LIMITS.left.min}
        max={PANE_LIMITS.left.max}
        onPointerDown={(event) => beginResize("left", event)}
        onKeyDown={(event) => handleResizeKey("left", event)}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{center}</div>

      {!compact ? (
        <>
          <ResizeHandle
            label="Resize commit inspector"
            value={sizes.right}
            min={PANE_LIMITS.right.min}
            max={PANE_LIMITS.right.max}
            onPointerDown={(event) => beginResize("right", event)}
            onKeyDown={(event) => handleResizeKey("right", event)}
          />
          <aside
            aria-label={rightLabel}
            className="min-h-0 shrink-0 overflow-hidden"
            style={{ width: sizes.right }}
          >
            {right}
          </aside>
        </>
      ) : rightOpen ? (
        <div className="absolute inset-0 z-40 flex justify-end" role="presentation">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 cursor-default"
            style={{ background: "color-mix(in srgb, var(--ink) 18%, transparent)" }}
            onClick={onCloseRight}
          />
          <aside
            aria-label={rightLabel}
            className="relative h-full min-h-0 w-[min(26rem,calc(100%-2rem))] border-l p-3 shadow-2xl"
            style={{
              borderLeftWidth: "0.5px",
              borderColor: "var(--hairline-strong)",
              background: "var(--paper)",
            }}
          >
            <button
              type="button"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={onCloseRight}
              className="interactive-control absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md"
              style={{ color: "var(--slate)" }}
            >
              <CloseIcon />
            </button>
            <div className="h-full min-h-0 overflow-hidden pt-7">{right}</div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ResizeHandle({
  label,
  value,
  min,
  max,
  onPointerDown,
  onKeyDown,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group relative flex h-full shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none"
      style={{ width: HANDLE_WIDTH }}
    >
      <span
        className="w-px transition-colors group-hover:bg-[var(--fjord)] group-focus-visible:bg-[var(--fjord)]"
        style={{ background: "var(--hairline)" }}
      />
    </div>
  );
}

function constrainPaneSize(
  pane: Pane,
  requestedSize: number,
  sizes: PaneSizes,
  containerWidth: number,
  compact: boolean,
) {
  const limits = PANE_LIMITS[pane];
  const reservedWidth =
    pane === "left"
      ? MIN_CENTER_WIDTH + HANDLE_WIDTH + (compact ? 0 : sizes.right + HANDLE_WIDTH)
      : MIN_CENTER_WIDTH + sizes.left + HANDLE_WIDTH * 2;
  const availableMaximum = Math.max(limits.min, containerWidth - reservedWidth);
  return Math.round(Math.min(Math.max(requestedSize, limits.min), limits.max, availableMaximum));
}

function readPaneSizes(): PaneSizes {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<PaneSizes> | null;
    return {
      left: validSize(saved?.left, PANE_LIMITS.left),
      right: validSize(saved?.right, PANE_LIMITS.right),
    };
  } catch {
    return { left: PANE_LIMITS.left.default, right: PANE_LIMITS.right.default };
  }
}

function validSize(value: number | undefined, limits: { min: number; max: number; default: number }) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, limits.min), limits.max)
    : limits.default;
}

function writePaneSizes(sizes: PaneSizes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // A read-only webview storage should not make resizing unusable.
  }
}

function CloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
