// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundBashOutput } from "@/hooks/useBackgroundBashOutput.js";
import type { BackgroundBashOutputResult } from "@zcode/shared";

const mocks = vi.hoisted(() => ({ query: vi.fn(), stop: vi.fn() }));
vi.mock("@/hooks/useZCodeAgentService.js", () => ({ useZCodeAgentService: () => service }));
vi.mock("@/v4/agentV4ConnectionHandshake.js", () => ({
  ensureAgentV4ConnectionHandshake: async () => ({}),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn() } }));
const service = { backgroundBashOutputV4: mocks.query, sendConversationCommandV4: mocks.stop };
const target = {
  workspacePath: "/project",
  workspaceIdentity: "ssh:a",
  remoteSessionId: "remote-a",
  sessionId: "session",
  workId: "work",
};
const output = (text: string, status = "running") => ({
  kind: "output",
  workId: "work",
  status,
  output: text,
  outputPath: "/output",
  truncated: false,
});
const tick = async (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(() => {
  vi.useFakeTimers();
  mocks.query.mockReset().mockResolvedValue(output("one"));
  mocks.stop.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("background Bash preview polling", () => {
  it("polls only visible tabs, replaces the tail, freezes reading, and retains terminal output", async () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useBackgroundBashOutput(target, visible),
      { initialProps: { visible: true } },
    );
    await tick();
    expect(result.current.display?.output).toBe("one");
    act(() => result.current.pause());
    mocks.query.mockResolvedValue(output("two"));
    await tick(1000);
    expect(result.current.display?.output).toBe("one");
    expect(result.current.latest?.output).toBe("two");
    act(() => result.current.resume());
    await tick();
    expect(result.current.display?.output).toBe("two");
    rerender({ visible: false });
    const count = mocks.query.mock.calls.length;
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(count);
    mocks.query.mockResolvedValue(output("final", "completed"));
    rerender({ visible: true });
    await tick();
    expect(result.current.latest?.status).toBe("completed");
    expect(result.current.display?.output).toBe("final");
    const terminalCount = mocks.query.mock.calls.length;
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(terminalCount);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith(target);
  });

  it("does not overlap a slow request or apply it after hiding", async () => {
    let resolve!: (value: BackgroundBashOutputResult) => void;
    mocks.query.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = renderHook(
      ({ visible }) => useBackgroundBashOutput(target, visible),
      { initialProps: { visible: true } },
    );
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    rerender({ visible: false });
    rerender({ visible: true });
    await tick();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await act(async () => resolve(output("stale") as BackgroundBashOutputResult));
    await tick();
    expect(result.current.display?.output).toBe("one");
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("retains successful output on failure and waits for retry", async () => {
    const { result } = renderHook(() => useBackgroundBashOutput(target, true));
    await tick();
    mocks.query.mockResolvedValue({ kind: "read_failed", workId: "work", code: "ENOENT" });
    await tick(1000);
    expect(result.current.error).toBe("read_failed");
    expect(result.current.display?.output).toBe("one");
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    mocks.query.mockResolvedValue(output("recovered"));
    act(() => result.current.refresh());
    await tick();
    expect(result.current.display?.output).toBe("recovered");
  });
  it("retains a frozen window at completion and applies final output on resume", async () => {
    const { result } = renderHook(() => useBackgroundBashOutput(target, true));
    await tick();
    act(() => result.current.pause());
    mocks.query.mockResolvedValue(output("final", "completed"));
    await tick(1000);
    expect(result.current.latest?.status).toBe("completed");
    expect(result.current.display?.output).toBe("one");
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    act(() => result.current.resume());
    await tick();
    expect(result.current.display?.output).toBe("final");
  });

  it("drops responses for closed tabs and does not cancel work", async () => {
    let resolve!: (value: BackgroundBashOutputResult) => void;
    mocks.query.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { unmount } = renderHook(() => useBackgroundBashOutput(target, true));
    await tick();
    unmount();
    await act(async () => resolve(output("late") as BackgroundBashOutputResult));
    await tick(5000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "unsupported"])(
    "stops polling on %s without a cancellation",
    async (kind) => {
      mocks.query.mockResolvedValue({ kind, workId: "work" });
      const { result } = renderHook(() => useBackgroundBashOutput(target, true));
      await tick(5000);
      expect(result.current.error).toBe(kind);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(mocks.stop).not.toHaveBeenCalled();
    },
  );
});
