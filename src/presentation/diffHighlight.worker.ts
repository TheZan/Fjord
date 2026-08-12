import { highlightDiffLines } from "@/presentation/diffHighlight";
import type {
  DiffHighlightWorkerRequest,
  DiffHighlightWorkerResponse,
} from "@/presentation/diffHighlightWorkerProtocol";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DiffHighlightWorkerRequest>) => void) | null;
  postMessage: (message: DiffHighlightWorkerResponse) => void;
};

workerScope.onmessage = ({ data }) => {
  const startedAt = performance.now();
  const result = highlightDiffLines(data.language, data.lines);
  workerScope.postMessage({
    requestId: data.requestId,
    ...result,
    durationMs: performance.now() - startedAt,
  });
};
