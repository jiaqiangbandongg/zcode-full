import { describe, expect, it, vi } from "vitest";
import { hostResponseMessageSchema, buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { reportHostSessionCreate } from "../src/host/hostSessionCreateTelemetry.js";

describe("Host session_create 转发合同", () => {
  it.each(["automation_idle", "automation_scheduled"] as const)(
    "%s 带远端类型，隐藏路径",
    (source) => {
      const port = { postMessage: vi.fn() };
      reportHostSessionCreate(port, {
        sessionId: "s1",
        messageId: "first-command",
        source,
        workspaceIdentity: buildRemoteWorkspaceIdentity("/private", {
          kind: "ssh",
          host: "private-host",
          username: "private-user",
        }),
      });
      const message = port.postMessage.mock.calls[0]![0];
      expect(hostResponseMessageSchema.safeParse(message).success).toBe(true);
      expect(message).toMatchObject({
        type: "session-create-telemetry",
        event: {
          talkId: "s1",
          messageId: "first-command",
          context: { screenResolution: "" },
          eventExtraDetail: {
            create_source: source,
            client_kind: "desktop",
            workspace_kind: "remote",
            remote_kind: "ssh",
          },
        },
      });
      expect(JSON.stringify(message)).not.toContain("private");
      expect(
        hostResponseMessageSchema.safeParse({
          ...message,
          event: { ...message.event, userId: "spoof" },
        }).success,
      ).toBe(false);
    },
  );
  it("IPC 已关闭不改变派发成功", () => {
    expect(() =>
      reportHostSessionCreate(
        {
          postMessage: () => {
            throw new Error("closed");
          },
        },
        { sessionId: "s1", messageId: "first-command", source: "automation_idle" },
      ),
    ).not.toThrow();
  });
});
