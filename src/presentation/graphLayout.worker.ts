import { computeGraphLayoutChunk, type GraphLayoutState } from "@/presentation/graphLayout";
import type {
  GraphLayoutWorkerRequest,
  GraphLayoutWorkerResponse,
} from "@/presentation/graphLayoutWorkerProtocol";
import type { CommitSummary } from "@/domain/git";

let cachedCommits: CommitSummary[] = [];
let cachedRows: ReturnType<typeof computeGraphLayoutChunk>["rows"] = [];
let cachedState: GraphLayoutState = { activeLanes: [], maxLaneCount: 0 };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<GraphLayoutWorkerRequest>) => void) | null;
  postMessage: (message: GraphLayoutWorkerResponse) => void;
};

workerScope.onmessage = ({ data }) => {
  const incremental = data.mode === "append";

  if (incremental) {
    const chunk = computeGraphLayoutChunk(data.commits, cachedState);
    cachedRows = [...cachedRows, ...chunk.rows];
    cachedState = chunk.state;
    cachedCommits = [...cachedCommits, ...data.commits];
  } else {
    const chunk = computeGraphLayoutChunk(data.commits);
    cachedRows = chunk.rows;
    cachedState = chunk.state;
    cachedCommits = data.commits;
  }

  workerScope.postMessage({
    requestId: data.requestId,
    commitCount: cachedCommits.length,
    layout: { rows: cachedRows, laneCount: cachedState.maxLaneCount },
    incremental,
  });
};
