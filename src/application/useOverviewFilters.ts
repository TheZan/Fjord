import { useCallback, useEffect, useRef, useState } from "react";
import type { UiOverviewFilter } from "@/domain/generated";
import { serializeHealthFilters } from "@/application/repoHealth";
import { loadUiState, saveOverviewFilters } from "@/infrastructure/uiState";

export interface OverviewFiltersState {
  filters: ReadonlySet<UiOverviewFilter>;
  toggleFilter: (filter: UiOverviewFilter) => void;
  clearFilters: () => void;
}

/**
 * Application-level owner for the persisted workspace health filters. Both
 * workspace screens consume this one instance from App.
 */
export function useOverviewFilters(): OverviewFiltersState {
  const [filters, setFilters] = useState<ReadonlySet<UiOverviewFilter>>(() => new Set());
  const filtersRef = useRef<ReadonlySet<UiOverviewFilter>>(filters);
  const localChangesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void loadUiState()
      .then((state) => {
        if (!cancelled && localChangesRef.current === 0) {
          const restored = new Set(state.overview.filters);
          filtersRef.current = restored;
          setFilters(restored);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((mutate: (next: Set<UiOverviewFilter>) => void) => {
    localChangesRef.current += 1;
    const next = new Set(filtersRef.current);
    mutate(next);
    filtersRef.current = next;
    setFilters(next);
    void saveOverviewFilters(serializeHealthFilters(next)).catch(() => undefined);
  }, []);

  const toggleFilter = useCallback(
    (filter: UiOverviewFilter) => {
      update((next) => {
        if (next.has(filter)) next.delete(filter);
        else next.add(filter);
      });
    },
    [update],
  );

  const clearFilters = useCallback(() => {
    update((next) => next.clear());
  }, [update]);

  return { filters, toggleFilter, clearFilters };
}
