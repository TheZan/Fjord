import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { languageForPath, type HighlightLineInput, type HighlightToken } from "@/presentation/diffHighlight";
import type { DiffHighlightWorkerResponse } from "@/presentation/diffHighlightWorkerProtocol";
import { recordDuration } from "@/presentation/performance";

interface HighlightResult {
  signature: string;
  tokens: Map<string, HighlightToken[]>;
}

const EMPTY_TOKENS = new Map<string, HighlightToken[]>();

export function useDiffHighlight(path: string, lines: HighlightLineInput[]): ReadonlyMap<string, HighlightToken[]> {
  const language = languageForPath(path);
  const signature = useMemo(() => highlightSignature(path, lines), [lines, path]);
  const requestId = useRef(0);
  const [result, setResult] = useState<HighlightResult | null>(null);
  const activeResult = result?.signature === signature ? result : null;

  useEffect(() => {
    if (!language || lines.length === 0 || typeof Worker === "undefined") return;
    let active = true;
    let worker: Worker | null = null;
    let timer: number | null = null;
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    const frame = window.requestAnimationFrame(() => {
      mark("fjord:diff:plain-paint", { lineCount: lines.length });
      timer = window.setTimeout(() => {
        if (!active) return;
        worker = new Worker(new URL("./diffHighlight.worker.ts", import.meta.url), { type: "module" });
        const onMessage = (event: MessageEvent<DiffHighlightWorkerResponse>) => {
          if (!active || event.data.requestId !== nextRequestId) return;
          recordDuration("fjord:diff:highlight-worker", event.data.durationMs, {
            language,
            lineCount: lines.length,
            skipped: event.data.skipped,
          });
          setResult({
            signature,
            tokens: new Map(event.data.lines.map((line) => [line.key, line.tokens])),
          });
        };
        const onError = () => {
          worker?.terminate();
          worker = null;
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError, { once: true });
        worker.postMessage({ requestId: nextRequestId, language, lines });
      }, 0);
    });

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [language, lines, signature]);

  useLayoutEffect(() => {
    if (activeResult) mark("fjord:diff:highlight-commit", { lineCount: activeResult.tokens.size });
  }, [activeResult]);

  return activeResult?.tokens ?? EMPTY_TOKENS;
}

function highlightSignature(path: string, lines: HighlightLineInput[]): string {
  let hash = 2_166_136_261;
  for (const line of lines) {
    const value = `${line.key}\0${line.content}\0`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return `${path}\0${lines.length}\0${hash >>> 0}`;
}

function mark(name: string, detail: Record<string, unknown>) {
  if (typeof performance?.mark !== "function") return;
  try {
    performance.clearMarks(name);
    performance.mark(name, { detail });
  } catch {
    // Older webviews may not support structured mark details.
  }
}
