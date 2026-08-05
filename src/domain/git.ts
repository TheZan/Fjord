// Mirrors `fjord_domain::{BranchInfo, CommitSummary, CommitPage, LogCursor}`
// (crates/fjord-domain/src/lib.rs). See the note in domain/settings.ts
// about generating these later.

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface TagInfo {
  name: string;
  targetCommitId: string;
}

export interface StashEntry {
  index: number;
  message: string;
}

export interface WorkingFile {
  path: string;
  changeType: FileChangeType;
  conflicted: boolean;
}

export interface WorkingChanges {
  staged: WorkingFile[];
  unstaged: WorkingFile[];
}

export interface RepoStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  hasConflict: boolean;
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

export type SearchResultKind = "repository" | "branch" | "commit";

export interface GlobalSearchResult {
  kind: SearchResultKind;
  repoId: string;
  workspaceId: string;
  repoName: string;
  repoPath: string;
  branch: string | null;
  commit: CommitSummary | null;
}

// Mirrors `fjord_domain::{FileChangeType, FileDiff, DiffLineKind, DiffLine,
// DiffHunk, FileDiffDetail}`.

export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  path: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
}

export type DiffLineKind = "context" | "addition" | "deletion";

export interface DiffLine {
  kind: DiffLineKind;
  oldLineno: number | null;
  newLineno: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiffDetail {
  path: string;
  changeType: FileChangeType;
  isBinary: boolean;
  hunks: DiffHunk[];
}
