import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { getV4ConfigProjection, switchV4Mode } from "#e2e/helpers/v4-conversation";

vi.mock("./e2e/helpers/v4-conversation.js", () => ({
  getV4ConfigProjection: vi.fn(),
  switchV4Mode: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("tool cross-product permission preparation", () => {
  it.each(["build", "yolo"])("uses the active V4 projection from %s", async (initialMode) => {
    let mode = initialMode;
    vi.mocked(getV4ConfigProjection).mockImplementation(async () => ({
      mode,
      planEnabled: false,
      usageUsed: 0,
      usageMax: 0,
    }));
    vi.mocked(switchV4Mode).mockImplementation(async (value) => {
      mode = value;
    });
    vi.stubGlobal("browser", {
      waitUntil: async (predicate: () => Promise<boolean>) => expect(await predicate()).toBe(true),
    });
    await ensureToolCrossProductFullAccessMode();
    expect(mode).toBe("yolo");
    expect(switchV4Mode).toHaveBeenCalledTimes(initialMode === "yolo" ? 0 : 1);
    if (initialMode !== "yolo") expect(switchV4Mode).toHaveBeenCalledWith("yolo");
  });

  it("does not accept a click without the mode projection changing", async () => {
    vi.mocked(getV4ConfigProjection).mockResolvedValue({
      mode: "build",
      planEnabled: false,
      usageUsed: 0,
      usageMax: 0,
    });
    vi.stubGlobal("browser", {
      waitUntil: async (predicate: () => Promise<boolean>, options: { timeoutMsg: string }) => {
        if (!(await predicate())) throw new Error(options.timeoutMsg);
      },
    });
    await expect(ensureToolCrossProductFullAccessMode()).rejects.toThrow("Full access");
  });
});
