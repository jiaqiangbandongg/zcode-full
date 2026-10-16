// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { SessionDebugSnapshot } from "@zcode/shared";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { useSessionDebug } from "../src/hooks/useSessionDebug.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const snapshot = (sessionId: string): SessionDebugSnapshot => ({
  sessionId,
  rounds: [],
  networkEntries: [],
  cache: { hitRateRequestCount: 1, totalInputTokens: 100, totalCacheReadTokens: 80, hitRate: 0.8 },
});
function setup(readSessionDebug: ReturnType<typeof vi.fn>) {
  const services = { zcodeAgentService: { readSessionDebug } } as unknown as IServiceAccessor;
  return ({ children }: { children: React.ReactNode }) =>
    createElement(ServiceProvider, { services, children });
}
describe("useSessionDebug", () => {
  it("discards pending results across task/workspace switches", async () => {
    let completeOld!: (data: SessionDebugSnapshot) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      )
      .mockResolvedValue(snapshot("new"));
    const { result, rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/same", workspaceIdentity: "ssh:one", taskId: "old" },
    });
    rerender({ workspacePath: "/same", workspaceIdentity: "ssh:two", taskId: "new" });
    await waitFor(() => expect(result.current.cache?.hitRateRequestCount).toBe(1));
    await act(async () => {
      completeOld({ ...snapshot("old"), cache: null });
    });
    expect(result.current.cache?.hitRateRequestCount).toBe(1);
    expect(read).toHaveBeenLastCalledWith({
      workspacePath: "/same",
      workspaceIdentity: "ssh:two",
      sessionId: "new",
    });
  });
  it("does not poll a hidden panel and shows read failures", async () => {
    const read = vi.fn().mockRejectedValue(new Error("not supported"));
    const { result, rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/work", taskId: "task", enabled: false },
    });
    expect(read).not.toHaveBeenCalled();
    rerender({ workspacePath: "/work", taskId: "task", enabled: true });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.rounds).toEqual([]);
  });
  it("refreshes serially and stops after hiding", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(snapshot("task"));
    const { rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/work", taskId: "task", enabled: true },
    });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    rerender({ workspacePath: "/work", taskId: "task", enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
