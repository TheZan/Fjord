import type { DiffLanguage, HighlightedLine, HighlightLineInput } from "@/presentation/diffHighlight";

export interface DiffHighlightWorkerRequest {
  requestId: number;
  language: DiffLanguage;
  lines: HighlightLineInput[];
}

export interface DiffHighlightWorkerResponse {
  requestId: number;
  lines: HighlightedLine[];
  skipped: "budget" | null;
  durationMs: number;
}
