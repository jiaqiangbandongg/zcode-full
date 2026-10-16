// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBotGroupTask } from "@/hooks/useBotGroupTask.js";
const mocks = vi.hoisted(() => ({
  getBotStates: vi.fn(),
  getConfig: vi.fn(),
  onMessage: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ botsService: mocks, broadcastService: mocks }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const state = (id: string) => ({
  botId: id,
  workspacePath: "/w",
  activeTaskId: id,
  group: { taskIds: [id], inputs: {} },
});
describe("bot task source channel", () => {
  it("reads Lark from config before the first accepted message exists", async () => {
    mocks.getBotStates.mockResolvedValue([state("a")]);
    mocks.getConfig.mockResolvedValue({ bots: [{ id: "a", provider: "lark" }] });
    const { result } = renderHook(() => useBotGroupTask("a", "/w"));
    await waitFor(() => expect(result.current.provider).toBe("lark"));
  });
  it("ignores late config from a previous task", async () => {
    mocks.getBotStates.mockResolvedValue([state("a"), state("b")]);
    let finish!: (value: unknown) => void;
    mocks.getConfig
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ bots: [{ id: "b", provider: "feishu" }] });
    const { result, rerender } = renderHook(({ id }) => useBotGroupTask(id, "/w"), {
      initialProps: { id: "a" },
    });
    await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledOnce());
    rerender({ id: "b" });
    await waitFor(() => expect(result.current.provider).toBe("feishu"));
    await act(async () => finish({ bots: [{ id: "a", provider: "lark" }] }));
    expect(result.current.provider).toBe("feishu");
    expect(result.current.context?.botId).toBe("b");
  });
});
