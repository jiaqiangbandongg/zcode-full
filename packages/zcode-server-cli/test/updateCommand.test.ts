import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";

const requestControl = vi.fn();
const prepareOnlineUpdate = vi.fn();

vi.mock("../src/ipc/controlClient.js", () => ({ requestControl }));
vi.mock("../src/runtime/updatePreparation.js", () => ({ prepareOnlineUpdate }));

const { runUpdateCommand } = await import("../src/runtime/updateCommand.js");

describe("runUpdateCommand cleanup errors", () => {
  const layout = resolveServerLayout("/tmp/zcode-update-command-test");

  beforeEach(() => {
    requestControl.mockReset();
    prepareOnlineUpdate.mockReset();
  });

  it("preserves the running-task guard when blocked-release cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("pending release could not be removed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl
      .mockResolvedValueOnce({ status: "ready", runningTaskCount: 0 })
      .mockResolvedValueOnce({ status: "blocked", runningTaskCount: 1 });

    await expect(
      runUpdateCommand([], {}, false, layout, vi.fn()),
    ).rejects.toThrow("Running tasks require --force for update");
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("preserves the running-task guard when apply cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("release directory could not be removed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl.mockResolvedValue({ status: "ready", runningTaskCount: 0 });
    const applyUpdate = vi.fn().mockRejectedValue(new Error("Running tasks require --force for update"));

    await expect(
      runUpdateCommand([], {}, false, layout, applyUpdate),
    ).rejects.toThrow("Running tasks require --force for update");
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("preserves a non-guard control error when cleanup fails", async () => {
    const discard = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    prepareOnlineUpdate.mockResolvedValue({ status: "prepared", version: "4.0.0", discard });
    requestControl
      .mockResolvedValueOnce({ status: "ready", runningTaskCount: 0 })
      .mockRejectedValueOnce(new Error("control socket unavailable"));

    await expect(
      runUpdateCommand([], {}, false, layout, vi.fn()),
    ).rejects.toThrow("control socket unavailable");
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
