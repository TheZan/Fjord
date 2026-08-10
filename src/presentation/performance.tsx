import { Profiler } from "react";
import type { ProfilerOnRenderCallback, ReactNode } from "react";
import { setIpcInteraction } from "@/infrastructure/tauriClient";

let interactionCounter = 0;
let diagnosticsEnabled = false;
let activeInteractionId: string | null = null;
const sessionNonce = createSessionNonce();

export function setInteractionDiagnosticsEnabled(enabled: boolean) {
  diagnosticsEnabled = enabled;
  if (!enabled) {
    activeInteractionId = null;
    setIpcInteraction(null);
  }
}

/**
 * Starts at the capture phase of a user input event. P6-09 will keep the
 * interaction open through its completion predicate; for the plumbing stage
 * the scope intentionally lasts through the current event/microtask only.
 */
export function beginInteraction(_event: Pick<Event, "timeStamp">): string | null {
  if (!diagnosticsEnabled) return null;
  const interactionId = `${sessionNonce}:${++interactionCounter}`;
  activeInteractionId = interactionId;
  setIpcInteraction(interactionId);
  queueMicrotask(() => {
    if (activeInteractionId === interactionId) {
      activeInteractionId = null;
      setIpcInteraction(null);
    }
  });
  return interactionId;
}

export function currentInteraction(): string | null {
  return activeInteractionId;
}

export function installInteractionCapture(): () => void {
  const capture = (event: Event) => {
    beginInteraction(event);
  };
  const eventTypes = ["click", "keydown", "input"] as const;
  for (const eventType of eventTypes) document.addEventListener(eventType, capture, true);
  return () => {
    for (const eventType of eventTypes) document.removeEventListener(eventType, capture, true);
  };
}

function createSessionNonce(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function measureSync<T>(name: string, detail: Record<string, unknown>, run: () => T): T {
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    recordDuration(name, performance.now() - startedAt, detail);
  }
}

export function recordDuration(
  name: string,
  duration: number,
  detail?: Record<string, unknown>,
) {
  if (typeof performance?.measure !== "function") return;
  try {
    performance.clearMeasures(name);
    performance.measure(name, {
      start: Math.max(0, performance.now() - duration),
      duration,
      detail,
    });
  } catch {
    // Older webviews may not support measure options or structured details.
  }
}

export function PerformanceBoundary({ id, children }: { id: string; children: ReactNode }) {
  if (!import.meta.env.DEV) return children;
  return <Profiler id={id} onRender={recordReactRender}>{children}</Profiler>;
}

const recordReactRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  recordDuration(`fjord:react:${id}`, actualDuration, { phase });
};
