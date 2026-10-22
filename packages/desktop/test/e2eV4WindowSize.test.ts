import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentElectronRendererContentSize } from "#e2e/helpers/desktop-app";
import { setV4ElectronWindowSize } from "#e2e/helpers/v4-conversation";

vi.mock("./e2e/helpers/desktop-app.js", () => ({
  DEFAULT_WORKSPACE: "/Users/dev/e2e/ZCodeProject",
  setCurrentElectronRendererContentSize: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("V4 E2E viewport preparation", () => {
  it("uses the current renderer content size helper instead of outer bounds", async () => {
    await setV4ElectronWindowSize(1440, 1000);
    expect(setCurrentElectronRendererContentSize).toHaveBeenCalledExactlyOnceWith(1440, 1000);
  });

  it("preserves a real content size application failure", async () => {
    vi.mocked(setCurrentElectronRendererContentSize).mockRejectedValueOnce(
      new Error("content size was not applied"),
    );
    await expect(setV4ElectronWindowSize(480, 800)).rejects.toThrow("content size was not applied");
  });
});
