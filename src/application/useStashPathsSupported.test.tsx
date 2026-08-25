import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStashPathsSupported } from "@/application/useStashPathsSupported";

const stashPathsSupportedMock = vi.hoisted(() => vi.fn());

vi.mock("@/infrastructure/tauriClient", () => ({
  stashPathsSupported: stashPathsSupportedMock,
}));

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useStashPathsSupported", () => {
  beforeEach(() => {
    stashPathsSupportedMock.mockReset();
  });

  it("treats an unresolved capability as unsupported", () => {
    stashPathsSupportedMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useStashPathsSupported(), { wrapper: wrapper() });

    expect(result.current).toBe(false);
  });

  it("keeps an explicitly unsupported capability disabled", async () => {
    stashPathsSupportedMock.mockResolvedValue(false);

    const { result } = renderHook(() => useStashPathsSupported(), { wrapper: wrapper() });

    await waitFor(() => expect(stashPathsSupportedMock).toHaveBeenCalledOnce());
    expect(result.current).toBe(false);
  });

  it("enables exact path scope only after a positive capability result", async () => {
    stashPathsSupportedMock.mockResolvedValue(true);

    const { result } = renderHook(() => useStashPathsSupported(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
