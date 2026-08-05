import type { FileChangeType } from "@/domain/git";

/** Shared between `CommitInspector`'s file list and `FileDiffView`'s header badge. */
export const CHANGE_TYPE_COLOR: Record<FileChangeType, string> = {
  added: "var(--moss)",
  modified: "var(--amber)",
  deleted: "var(--rust)",
  renamed: "var(--fjord)",
};
