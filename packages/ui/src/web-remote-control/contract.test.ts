import { describe, expect, it } from "vitest";
import {
  isSameWebRemoteControlTarget,
  isReusableWebRemoteControlSession,
} from "@/web-remote-control/index.js";

describe("remote control UI target contract", () => {
  it("keeps identity and remote session distinct from display paths", () => {
    const status = {
      status: "active",
      workspacePath: "/project",
      workspaceIdentity: "host-a",
      remoteSessionId: "session-a",
      sessionId: "relay",
      mobileConnected: true,
    } as const;
    expect(isSameWebRemoteControlTarget(status, "/project", "host-a", "session-a")).toBe(true);
    expect(isSameWebRemoteControlTarget(status, "/project", "host-b", "session-a")).toBe(false);
    expect(isSameWebRemoteControlTarget(status, "/project", "host-a", "session-b")).toBe(false);
    expect(isReusableWebRemoteControlSession(status)).toBe(true);
  });
});
