// Repository watchers and Git operations invalidate these queries explicitly.
// Keeping them fresh avoids repeating expensive repository reads on remount.
export const REPOSITORY_QUERY_STALE_TIME = Infinity;
export const REPOSITORY_QUERY_GC_TIME = 30 * 60 * 1_000;
export const REPOSITORY_LOG_PAGE_SIZE = 30;
