import { useQuery, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";

export type WorkingDiffSource = "worktree" | "index";

type DiffSnapshotAuthority = {
  latestFetchSequence: number;
  rejectedAtFetchSequence: number | null;
};

const initialAuthority: DiffSnapshotAuthority = {
  latestFetchSequence: 0,
  rejectedAtFetchSequence: null,
};

export function workingDiffSourceKey(source: WorkingDiffSource): string {
  return `working:${source === "index"}`;
}

export function beginWorkingDiffFetch(
  queryClient: QueryClient,
  repoId: string,
  path: string,
  sourceKey: string,
): number {
  const key = queryKeys.repos.fileDiffAuthority(repoId, path, sourceKey);
  const current = queryClient.getQueryData<DiffSnapshotAuthority>(key) ?? initialAuthority;
  const next = current.latestFetchSequence + 1;
  queryClient.setQueryData<DiffSnapshotAuthority>(key, {
    ...current,
    latestFetchSequence: next,
  });
  return next;
}

export function rejectWorkingDiffSnapshot(
  queryClient: QueryClient,
  repoId: string,
  path: string,
  source: WorkingDiffSource,
): void {
  const key = queryKeys.repos.fileDiffAuthority(repoId, path, workingDiffSourceKey(source));
  const current = queryClient.getQueryData<DiffSnapshotAuthority>(key) ?? initialAuthority;
  queryClient.setQueryData<DiffSnapshotAuthority>(key, {
    ...current,
    rejectedAtFetchSequence: current.latestFetchSequence,
  });
}

export function acceptWorkingDiffSnapshot(
  queryClient: QueryClient,
  repoId: string,
  path: string,
  sourceKey: string,
  successfulFetchSequence: number,
): void {
  const key = queryKeys.repos.fileDiffAuthority(repoId, path, sourceKey);
  const current = queryClient.getQueryData<DiffSnapshotAuthority>(key) ?? initialAuthority;
  if (
    current.rejectedAtFetchSequence === null
    || successfulFetchSequence <= current.rejectedAtFetchSequence
  ) return;

  queryClient.setQueryData<DiffSnapshotAuthority>(key, {
    ...current,
    rejectedAtFetchSequence: null,
  });
}

export function isWorkingDiffSnapshotRejected(
  queryClient: QueryClient,
  repoId: string,
  path: string,
  source: WorkingDiffSource,
): boolean {
  return getAuthority(queryClient, repoId, path, workingDiffSourceKey(source)).rejectedAtFetchSequence !== null;
}

export function useWorkingDiffSnapshotRejected(
  repoId: string | null,
  path: string | null,
  sourceKey: string | null,
): boolean {
  const enabled = repoId !== null && path !== null && sourceKey?.startsWith("working:") === true;
  const key = enabled
    ? queryKeys.repos.fileDiffAuthority(repoId, path, sourceKey)
    : ["diffSnapshotAuthority", "inactive"] as const;
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => initialAuthority,
    enabled: false,
    initialData: initialAuthority,
    gcTime: Infinity,
  });
  return enabled && data.rejectedAtFetchSequence !== null;
}

function getAuthority(
  queryClient: QueryClient,
  repoId: string,
  path: string,
  sourceKey: string,
): DiffSnapshotAuthority {
  return queryClient.getQueryData<DiffSnapshotAuthority>(
    queryKeys.repos.fileDiffAuthority(repoId, path, sourceKey),
  ) ?? initialAuthority;
}
