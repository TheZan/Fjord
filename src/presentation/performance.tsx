import { Profiler, useLayoutEffect } from "react";
import type { ProfilerOnRenderCallback, ReactNode } from "react";
import {
  setIpcInteraction,
  setIpcInteractionHooks,
} from "@/infrastructure/ipcInteraction";

let interactionCounter = 0;
let diagnosticsEnabled = false;
let activeInteractionId: string | null = null;
const sessionNonce = createSessionNonce();
const pendingInteractions = new Map<string, PendingInteraction>();
const completedInteractions: FrontendInteractionTrace[] = [];
const interactionMeasureNames = new Set<string>();
const MAX_INTERACTION_TRACES = 512;

export type FrontendInteractionPhase =
  | "input_to_dispatch"
  | "dispatch_to_ipc_send"
  | "ipc_round_trip"
  | "ipc_return_to_react_commit"
  | "react_commit_to_paint";

export interface FrontendInteractionTrace {
  interactionId: string;
  completionPredicate: string;
  wallDurationMs: number;
  phases: Partial<Record<FrontendInteractionPhase, number>>;
  ipcCalls: Array<{
    command: string;
    roundTripMs: number;
  }>;
}

export interface SevenPhaseDurations {
  inputToDispatch: number;
  dispatchToIpcSend: number;
  ipcSendToHandlerEntry: number;
  handler: number;
  handlerExitToIpcReturn: number;
  ipcReturnToReactCommit: number;
  reactCommitToPaint: number;
}

interface PendingInteraction {
  interactionId: string;
  inputAt: number;
  dispatchAt: number;
  dispatchSettled: boolean;
  completionPredicate: () => boolean;
  completionPredicateName: string;
  calls: PendingIpcCall[];
  lastCommitAt: number | null;
  dispatchTimer: ReturnType<typeof setTimeout> | null;
  paintFrame: number | null;
}

interface PendingIpcCall {
  requestId: number;
  command: string;
  sentAt: number;
  returnedAt: number | null;
}

export function setInteractionDiagnosticsEnabled(enabled: boolean) {
  diagnosticsEnabled = enabled;
  if (!enabled) {
    clearInteractionState();
  }
}

/**
 * Starts at the capture phase of a user input event. The trace stays active
 * until the first paint whose commit satisfies its completion predicate.
 */
export function beginInteraction(event: Pick<Event, "timeStamp">): string | null {
  if (!diagnosticsEnabled) return null;
  const interactionId = `${sessionNonce}:${++interactionCounter}`;
  const dispatchAt = performance.now();
  const trace: PendingInteraction = {
    interactionId,
    inputAt: normalizeEventTimestamp(event.timeStamp, dispatchAt),
    dispatchAt,
    dispatchSettled: false,
    completionPredicate: () => true,
    completionPredicateName: "ipc_settled",
    calls: [],
    lastCommitAt: null,
    dispatchTimer: null,
    paintFrame: null,
  };
  pendingInteractions.set(interactionId, trace);
  enforcePendingTraceBound();
  activeInteractionId = interactionId;
  setIpcInteraction(interactionId);
  recordInteractionPhase(trace, "input_to_dispatch", trace.inputAt, dispatchAt);
  trace.dispatchTimer = setTimeout(() => {
    trace.dispatchTimer = null;
    trace.dispatchSettled = true;
    maybeSchedulePaint(trace);
  }, 0);
  return interactionId;
}

export function currentInteraction(): string | null {
  return activeInteractionId;
}

/** Overrides the default "all IPC settled" rule for the current interaction. */
export function completeInteractionWhen(predicate: () => boolean, name: string) {
  if (!activeInteractionId) return;
  const trace = pendingInteractions.get(activeInteractionId);
  if (!trace) return;
  trace.completionPredicate = predicate;
  trace.completionPredicateName = sanitizeLabel(name);
}

export function drainFrontendInteractionTraces(): FrontendInteractionTrace[] {
  const drained = completedInteractions.splice(0);
  for (const trace of drained) clearInteractionMeasures(trace.interactionId);
  return drained;
}

export function sevenPhaseCoverageError(
  phases: SevenPhaseDurations,
  wallDurationMs: number,
): number {
  if (!(wallDurationMs > 0)) return Number.POSITIVE_INFINITY;
  const phaseTotal = Object.values(phases).reduce((total, duration) => total + duration, 0);
  return Math.abs(phaseTotal - wallDurationMs) / wallDurationMs;
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

function markIpcSend(interactionId: string, requestId: number, command: string, sentAt: number) {
  const trace = pendingInteractions.get(interactionId);
  if (!trace) return;
  cancelScheduledPaint(trace);
  if (trace.calls.length === 0) {
    recordInteractionPhase(trace, "dispatch_to_ipc_send", trace.dispatchAt, sentAt);
  }
  trace.calls.push({ requestId, command, sentAt, returnedAt: null });
}

function markIpcSettle(
  interactionId: string,
  requestId: number,
  _command: string,
  returnedAt: number,
) {
  const trace = pendingInteractions.get(interactionId);
  if (!trace) return;
  const call = trace.calls.find((candidate) => candidate.requestId === requestId);
  if (!call) return;
  call.returnedAt = returnedAt;
}

export function recordInteractionCommit(commitAt: number) {
  if (!diagnosticsEnabled) return;
  for (const trace of pendingInteractions.values()) {
    if (lastIpcReturn(trace) > commitAt) continue;
    trace.lastCommitAt = commitAt;
    maybeSchedulePaint(trace);
  }
}

function maybeSchedulePaint(trace: PendingInteraction) {
  if (
    trace.paintFrame !== null ||
    !trace.dispatchSettled ||
    trace.lastCommitAt === null ||
    trace.calls.some((call) => call.returnedAt === null) ||
    !completionPredicateSatisfied(trace)
  ) {
    return;
  }
  const commitAt = trace.lastCommitAt;
  trace.paintFrame = requestFrame((paintAt) => {
    trace.paintFrame = null;
    if (!pendingInteractions.has(trace.interactionId) || !completionPredicateSatisfied(trace)) return;
    completeInteraction(trace, commitAt, paintAt);
  });
}

function completeInteraction(trace: PendingInteraction, commitAt: number, paintAt: number) {
  const lastReturnAt = lastIpcReturn(trace);
  const phases: FrontendInteractionTrace["phases"] = {
    input_to_dispatch: durationBetween(trace.inputAt, trace.dispatchAt),
    react_commit_to_paint: durationBetween(commitAt, paintAt),
  };
  if (trace.calls.length > 0) {
    phases.dispatch_to_ipc_send = durationBetween(trace.dispatchAt, trace.calls[0].sentAt);
    phases.ipc_round_trip = durationBetween(trace.calls[0].sentAt, lastReturnAt);
    phases.ipc_return_to_react_commit = durationBetween(lastReturnAt, commitAt);
    recordInteractionPhase(trace, "ipc_round_trip", trace.calls[0].sentAt, lastReturnAt);
    recordInteractionPhase(trace, "ipc_return_to_react_commit", lastReturnAt, commitAt);
  }
  recordInteractionPhase(trace, "react_commit_to_paint", commitAt, paintAt);

  completedInteractions.push({
    interactionId: trace.interactionId,
    completionPredicate: trace.completionPredicateName,
    wallDurationMs: durationBetween(trace.inputAt, paintAt),
    phases,
    ipcCalls: trace.calls.flatMap((call) =>
      call.returnedAt === null
        ? []
        : [{ command: call.command, roundTripMs: durationBetween(call.sentAt, call.returnedAt) }],
    ),
  });
  if (completedInteractions.length > MAX_INTERACTION_TRACES) {
    const evicted = completedInteractions.shift();
    if (evicted) clearInteractionMeasures(evicted.interactionId);
  }
  pendingInteractions.delete(trace.interactionId);
  if (activeInteractionId === trace.interactionId) {
    activateLatestPendingInteraction();
  }
}

function recordInteractionPhase(
  trace: PendingInteraction,
  phase: FrontendInteractionPhase,
  start: number,
  end: number,
) {
  if (typeof performance?.measure !== "function") return;
  const name = `fjord:interaction:${trace.interactionId}:${phase}`;
  try {
    performance.measure(name, {
      start: Math.max(0, start),
      duration: durationBetween(start, end),
      detail: { interactionId: trace.interactionId, phase, source: "frontend" },
    });
    interactionMeasureNames.add(name);
  } catch {
    // Older webviews may not support measure options or structured details.
  }
}

function completionPredicateSatisfied(trace: PendingInteraction): boolean {
  try {
    return trace.completionPredicate();
  } catch {
    return false;
  }
}

function lastIpcReturn(trace: PendingInteraction): number {
  return trace.calls.reduce(
    (latest, call) => Math.max(latest, call.returnedAt ?? Number.POSITIVE_INFINITY),
    trace.dispatchAt,
  );
}

function durationBetween(start: number, end: number): number {
  return Math.max(0, end - start);
}

function normalizeEventTimestamp(eventTimestamp: number, now: number): number {
  let timestamp = eventTimestamp;
  if (timestamp > now + 60_000 && Number.isFinite(performance.timeOrigin)) {
    timestamp -= performance.timeOrigin;
  }
  return Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now ? timestamp : now;
}

function sanitizeLabel(label: string): string {
  return label.length > 0 && label.length <= 48 && /^[a-z0-9_-]+$/i.test(label)
    ? label
    : "custom";
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelScheduledPaint(trace: PendingInteraction) {
  if (trace.paintFrame === null) return;
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(trace.paintFrame);
  else window.clearTimeout(trace.paintFrame);
  trace.paintFrame = null;
}

function enforcePendingTraceBound() {
  while (pendingInteractions.size > MAX_INTERACTION_TRACES) {
    const oldest = pendingInteractions.values().next().value as PendingInteraction | undefined;
    if (!oldest) return;
    discardPendingTrace(oldest);
  }
}

function discardPendingTrace(trace: PendingInteraction) {
  if (trace.dispatchTimer !== null) clearTimeout(trace.dispatchTimer);
  cancelScheduledPaint(trace);
  pendingInteractions.delete(trace.interactionId);
  clearInteractionMeasures(trace.interactionId);
  if (activeInteractionId === trace.interactionId) activateLatestPendingInteraction();
}

function activateLatestPendingInteraction() {
  const latest = Array.from(pendingInteractions.keys()).at(-1) ?? null;
  activeInteractionId = latest;
  setIpcInteraction(latest);
}

function clearInteractionMeasures(interactionId: string) {
  const prefix = `fjord:interaction:${interactionId}:`;
  for (const name of interactionMeasureNames) {
    if (!name.startsWith(prefix)) continue;
    performance.clearMeasures(name);
    interactionMeasureNames.delete(name);
  }
}

function clearInteractionState() {
  for (const trace of pendingInteractions.values()) discardPendingTrace(trace);
  completedInteractions.splice(0);
  for (const name of interactionMeasureNames) performance.clearMeasures(name);
  interactionMeasureNames.clear();
  activeInteractionId = null;
  setIpcInteraction(null);
}

setIpcInteractionHooks({
  onSend: markIpcSend,
  onSettle: markIpcSettle,
});

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

export function InteractionPerformanceBoundary({ children }: { children: ReactNode }) {
  return <Profiler id="interaction-root" onRender={recordInteractionRender}>{children}</Profiler>;
}

/** Production fallback for regular React builds where Profiler callbacks are disabled. */
export function useInteractionCommit() {
  useLayoutEffect(() => recordInteractionCommit(performance.now()));
}

const recordInteractionRender: ProfilerOnRenderCallback = (
  _id,
  _phase,
  _actualDuration,
  _baseDuration,
  _startTime,
  commitTime,
) => {
  recordInteractionCommit(commitTime);
};

const recordReactRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _base, _start, commitTime) => {
  recordDuration(`fjord:react:${id}`, actualDuration, { phase });
  recordInteractionCommit(commitTime);
};
