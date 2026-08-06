import type { CommitSummary } from "@/domain/git";
import type { GraphLayout } from "@/presentation/graphLayout";

export interface GraphLayoutWorkerRequest {
  requestId: number;
  mode: "reset" | "append";
  commits: CommitSummary[];
}

export interface GraphLayoutWorkerResponse {
  requestId: number;
  commitCount: number;
  layout: GraphLayout;
  incremental: boolean;
}
