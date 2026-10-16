import { describe, expect, it, vi } from "vitest";
import { PlatformChannels, type WebRemoteControlStatus } from "@zcode/shared";
import { sendWebRemoteControlStatusChangedToWindow } from "@desktop/main/webRemoteControlStatusEvents.js";

function createTargetWindow({
  windowDestroyed = false,
  webContentsDestroyed = false,
}: {
  windowDestroyed?: boolean;
  webContentsDestroyed?: boolean;
} = {}) {
  return {
    isDestroyed: vi.fn(() => windowDestroyed),
    webContents: {
      isDestroyed: vi.fn(() => webContentsDestroyed),
      send: vi.fn(),
    },
  };
}

describe("sendWebRemoteControlStatusChangedToWindow", () => {
  const status: WebRemoteControlStatus = {
    status: "running",
    sessionId: "sid-1",
  };

  it("sends the status event to a live renderer", () => {
    const targetWindow = createTargetWindow();

    sendWebRemoteControlStatusChangedToWindow(targetWindow, status);

    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.WebRemoteControlStatusChanged,
      status,
    );
  });

  it("skips the status event after webContents has been destroyed", () => {
    const targetWindow = createTargetWindow({ webContentsDestroyed: true });

    sendWebRemoteControlStatusChangedToWindow(targetWindow, status);

    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("skips the status event after the window has been destroyed", () => {
    const targetWindow = createTargetWindow({ windowDestroyed: true });

    sendWebRemoteControlStatusChangedToWindow(targetWindow, status);

    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });
});
