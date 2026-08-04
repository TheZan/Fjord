// Mirrors `fjord_domain::{BranchInfo, CommitSummary, CommitPage, LogCursor}`
// (crates/fjord-domain/src/lib.rs). See the note in domain/settings.ts
// about generating these later.

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface CommitSummary {
  id: string;
  parentIds: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  refs: string[];
}

// Opaque — round-trip whatever `CommitPage.nextCursor` returned, never
// construct one. See docs/specs/git-backend.md.
export type LogCursor = string;

export interface CommitPage {
  commits: CommitSummary[];
  nextCursor: LogCursor | null;
}
