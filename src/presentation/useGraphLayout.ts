import { useEffect, useMemo, useRef, useState } from "react";
import { computeGraphLayout, type GraphLayout } from "@/presentation/graphLayout";
import { measureSync, recordDuration } from "@/presentation/performance";
import type {
  GraphLayoutWorkerRequest,
  GraphLayoutWorkerResponse,
} from "@/presentation/graphLayoutWorkerProtocol";
import type { CommitSummary } from "@/domain/git";

const WORKER_THRESHOLD = 180;
const EMPTY_LAYOUT: GraphLayout = { rows: [], laneCount: 0 };

interface WorkerLayoutResult extends GraphLayoutWorkerResponse {
  headId: string | null;
}

export function useGraphLayout(commits: CommitSummary[]) {
  const supportsWorker = typeof Worker !== "undefined";
  const shouldUseWorker = supportsWorker && commits.length >= WORKER_THRESHOLD;
  const synchronousLayout = useMemo(
    () =>
      shouldUseWorker
        ? null
        : measureSync("fjord:graph-layout:sync", { commitCount: commits.length }, () =>
            computeGraphLayout(commits),
          ),
    [commits, shouldUseWorker],
  );
  const workerRef = useRef<Worker | null>(null);
  const sentCommitsRef = useRef<CommitSummary[]>([]);
  const requestIdRef = useRef(0);
  const [workerResult, setWorkerResult] = useState<WorkerLayoutResult | null>(null);

  useEffect(() => {
    if (!shouldUseWorker) return;
    const worker =
      workerRef.current ??
      new Worker(new URL("./graphLayout.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const sentCommits = sentCommitsRef.current;
    const appendOnly =
      sentCommits.length <= commits.length &&
      sentCommits.every((commit, index) => commit.id === commits[index]?.id);
    const requestCommits = appendOnly ? commits.slice(sentCommits.length) : commits;

    const onMessage = (event: MessageEvent<GraphLayoutWorkerResponse>) => {
      if (event.data.requestId !== requestId) return;
      recordDuration("fjord:graph-layout:worker", event.data.durationMs, {
        commitCount: event.data.commitCount,
        incremental: event.data.incremental,
      });
      setWorkerResult({ ...event.data, headId: commits[0]?.id ?? null });
    };
    const onError = () => {
      worker.terminate();
      workerRef.current = null;
      sentCommitsRef.current = [];
      setWorkerResult({
        requestId,
        commitCount: commits.length,
        headId: commits[0]?.id ?? null,
        layout: computeGraphLayout(commits),
        incremental: false,
        durationMs: 0,
      });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError, { once: true });
    worker.postMessage({
      requestId,
      mode: appendOnly ? "append" : "reset",
      commits: requestCommits,
    } satisfies GraphLayoutWorkerRequest);
    sentCommitsRef.current = commits;
    return () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  }, [commits, shouldUseWorker]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      sentCommitsRef.current = [];
    },
    [],
  );

  if (synchronousLayout) return { ...synchronousLayout, computing: false, incremental: false };

  const reusableResult =
    workerResult &&
    workerResult.headId === (commits[0]?.id ?? null) &&
    workerResult.commitCount <= commits.length &&
    workerResult.layout.rows.every((row, index) => row.commit.id === commits[index]?.id)
      ? workerResult
      : null;

  return {
    ...(reusableResult?.layout ?? EMPTY_LAYOUT),
    computing: reusableResult?.commitCount !== commits.length,
    incremental: reusableResult?.incremental ?? false,
  };
}
