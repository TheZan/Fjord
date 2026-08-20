import type { PatchSelection, PatchSource } from "@/domain/git";
import { getWorkingFileDiffWithGenerations } from "@/infrastructure/tauriClient";

/** The complete diff for the path did not fit in one bounded window. */
export class IncompleteWorkingDiffError extends Error {}

/**
 * Fetches the current complete diff for one working-file row and builds the
 * whole-file `PatchSelection` every P8-01 patch consumer (discard, patch
 * export) needs — every hunk, unfiltered (`lines: []`), with the digest
 * that ties the selection to the exact diff it was read from.
 */
export async function buildWholeFilePatchSelection(
  repoId: string,
  path: string,
  source: PatchSource,
): Promise<PatchSelection> {
  const response = await getWorkingFileDiffWithGenerations(repoId, path, source === "index", 0, 2_000);
  const diff = response.data;
  if (diff.truncated || diff.nextOffset !== null || !diff.baseDigest) {
    throw new IncompleteWorkingDiffError();
  }
  return {
    path,
    source,
    baseDigest: diff.baseDigest,
    hunks: diff.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [],
    })),
  };
}
