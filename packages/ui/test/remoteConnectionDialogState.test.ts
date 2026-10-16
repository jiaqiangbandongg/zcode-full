import { describe, expect, it } from "vitest";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  getRemoteConnectionDialogResumeStep,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
  type RemoteConnectionDialogSnapshot,
} from "@/lib/remoteConnectionDialogState.js";

const baseSnapshot: RemoteConnectionDialogSnapshot = {
  currentStep: "kind",
  loading: false,
  connectedSessionId: null,
};

describe("remoteConnectionDialogState", () => {
  it("keeps minimized connecting flow active and resumes the connecting step", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: true,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(false);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("connecting");
  });

  it("keeps connected directory selection active after minimizing", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "directory",
      connectedSessionId: "session-1",
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(false);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("directory");
  });

  it("resets idle flow when opened again", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "kind",
      loading: false,
      connectedSessionId: null,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(false);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(true);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("kind");
  });

  it("keeps failed connecting step so users can see the failure context", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: false,
      connectedSessionId: null,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(false);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(true);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("connecting");
  });

  it("reopens minimized dialog at directory step after connection succeeds", () => {
    expect(getRemoteConnectionCompletionDialogState("success")).toEqual({
      open: true,
      step: "directory",
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
