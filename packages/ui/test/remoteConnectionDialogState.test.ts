import { describe, expect, it } from "vitest";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
  type RemoteConnectionDialogSnapshot,
} from "@/lib/remoteConnectionDialogState.js";

const baseSnapshot: RemoteConnectionDialogSnapshot = {
  currentStep: "device",
  loading: false,
  connectedSessionId: null,
};

describe("remoteConnectionDialogState", () => {
  it("keeps minimized connecting flow active", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: true,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
  });

  it("keeps connected directory selection active after minimizing", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "directory",
      connectedSessionId: "session-1",
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
  });

  it("does not treat idle device selection as an active connection", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "device",
      loading: false,
      connectedSessionId: null,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(false);
  });

  it("does not treat the failed connecting step as an active connection", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: false,
      connectedSessionId: null,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(false);
  });

  it("reopens minimized dialog at the ready connecting step after connection succeeds", () => {
    expect(getRemoteConnectionCompletionDialogState("success")).toEqual({
      open: true,
      step: "connecting",
    });
  });

  it("jumps straight to the directory step for the online-device direct flow", () => {
    // 原型 rail-foot：已有设备可从第 1 步直达第 5 步——在线卡「选择其他目录」成功后不在第 4 步停留。
    expect(
      getRemoteConnectionCompletionDialogState("success", {
        directToDirectory: true,
      }),
    ).toEqual({
      open: true,
      step: "directory",
    });
  });

  it("stays on the connecting step when the direct flow fails", () => {
    expect(
      getRemoteConnectionCompletionDialogState("error", {
        directToDirectory: true,
      }),
    ).toEqual({
      open: true,
      step: "connecting",
    });
  });

  it("reopens minimized dialog at connecting step after connection fails", () => {
    expect(getRemoteConnectionCompletionDialogState("error")).toEqual({
      open: true,
      step: "connecting",
    });
  });

  it("returns to settings when directory finalization disposed the logical session", () => {
    expect(
      getRemoteConnectionDirectoryFailureState({
        connectedSessionId: "remote-session-1",
        sessionStillRegistered: false,
      }),
    ).toEqual({
      connectedSessionId: null,
      step: "settings",
    });
  });

  it("keeps directory services available for retry when the logical session survives", () => {
    expect(
      getRemoteConnectionDirectoryFailureState({
        connectedSessionId: "remote-session-1",
        sessionStillRegistered: true,
      }),
    ).toEqual({
      connectedSessionId: "remote-session-1",
      step: "directory",
    });
  });
});
