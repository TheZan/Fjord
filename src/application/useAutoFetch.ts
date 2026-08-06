import { useEffect, useState } from "react";
import { fetchRepo, invokeErrorMessage } from "@/infrastructure/tauriClient";

const INITIAL_FETCH_DELAY_MS = 3_000;
const FETCH_INTERVAL_MS = 60_000;
const INACTIVE_RECHECK_MS = 15_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

export function autoFetchRetryDelay(failures: number) {
  return Math.min(FETCH_INTERVAL_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Fetches only the open repository while the desktop window is active.
 * Native ref events drive query invalidation, so a no-op fetch does not
 * redraw or reread the commit graph.
 */
export function useAutoFetch(repoId: string, enabled: boolean) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!enabled) return;

    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let lastFinishedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    };

    const isActive = () =>
      document.visibilityState === "visible" && document.hasFocus() && navigator.onLine;

    const run = async () => {
      if (stopped || inFlight) return;
      if (!isActive()) {
        schedule(INACTIVE_RECHECK_MS);
        return;
      }

      inFlight = true;
      try {
        await fetchRepo(repoId, "origin");
        if (stopped) return;
        failures = 0;
        lastFinishedAt = Date.now();
        setError(null);
        schedule(FETCH_INTERVAL_MS);
      } catch (reason) {
        if (stopped) return;
        failures += 1;
        lastFinishedAt = Date.now();
        setError(invokeErrorMessage(reason));
        schedule(autoFetchRetryDelay(failures));
      } finally {
        inFlight = false;
      }
    };

    const wake = () => {
      if (!isActive() || inFlight) return;
      const elapsed = Date.now() - lastFinishedAt;
      schedule(lastFinishedAt === 0 ? INITIAL_FETCH_DELAY_MS : Math.max(1_000, FETCH_INTERVAL_MS - elapsed));
    };

    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    schedule(INITIAL_FETCH_DELAY_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled, repoId]);

  return { error };
}
