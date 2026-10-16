import { describe, expect, it, vi } from "vitest";
import { InternalChannels } from "@zcode/shared";
import {
  notifyRemoteWorkspaceServicePortReady,
  parseRemoteWorkspaceServicePortMessage,
} from "../src/renderer/src/remoteWorkspaceServicePortBridge.js";

describe("remoteWorkspaceServicePortBridge", () => {
  it("解析带 attachmentId 的 scoped service port", () => {
    const port = {} as MessagePort;
    const target = { kind: "ssh", host: "dev.internal", username: "developer" } as const;

    expect(
      parseRemoteWorkspaceServicePortMessage({
        data: {
          type: InternalChannels.ScopedServicePort,
          attachmentId: "attachment-b",
          sessionId: "remote-session-1",
          target,
        },
        ports: [port],
      } as unknown as MessageEvent),
    ).toEqual({
      attachmentId: "attachment-b",
      port,
      sessionId: "remote-session-1",
      target,
    });
  });

  it("services 注册完成后发送 attachment-ready ACK", () => {
    const postMessage = vi.fn();

    notifyRemoteWorkspaceServicePortReady(
      { attachmentId: "attachment-b", sessionId: "remote-session-1" },
      postMessage,
    );

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: InternalChannels.ScopedServicePortReady,
        attachmentId: "attachment-b",
        sessionId: "remote-session-1",
      },
      "*",
    );
  });
});
