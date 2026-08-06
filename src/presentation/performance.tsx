import { Profiler } from "react";
import type { ProfilerOnRenderCallback, ReactNode } from "react";

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
