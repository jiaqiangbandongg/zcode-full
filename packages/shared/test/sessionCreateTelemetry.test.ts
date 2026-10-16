import { describe, expect, it } from "vitest";
import {
  sessionCreateTelemetrySchema,
  resolveWorkspaceTelemetryDetail,
  parseWebRemoteControlAppPayload,
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";

describe("session_create 手机合同", () => {
  const event = {
    elementName: "session_create",
    eventRegion: "app",
    eventType: "result",
    talkId: "session-1",
    messageId: "first-command",
    context: {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "390x844",
    },
    eventExtraDetail: {
      create_source: "project",
      client_kind: "mobile",
      workspace_kind: "local",
      remote_kind: "",
    },
  };
  it("只允许手机 session_create，保留手机 context", () => {
    expect(parseWebRemoteControlAppPayload({ zcode_type: "telemetry-report", event })).toEqual({
      zcode_type: "telemetry-report",
      event,
    });
    expect(
      sessionCreateTelemetrySchema.safeParse({ ...event, elementName: "send_btn" }).success,
    ).toBe(false);
    expect(sessionCreateTelemetrySchema.safeParse({ ...event, userId: "spoof" }).success).toBe(
      false,
    );
    expect(
      sessionCreateTelemetrySchema.safeParse({
        ...event,
        eventExtraDetail: { ...event.eventExtraDetail, workspace_path: "/private" },
      }).success,
    ).toBe(false);
  });
  it("缺失或空 messageId 不可上传", () => {
    const { messageId: _messageId, ...missing } = event;
    expect(sessionCreateTelemetrySchema.safeParse(missing).success).toBe(false);
    expect(sessionCreateTelemetrySchema.safeParse({ ...event, messageId: "" }).success).toBe(false);
  });
  it("未知 identity 或仅 remoteSessionId 不能误记 local", () => {
    expect(resolveWorkspaceTelemetryDetail({ workspaceIdentity: "future-format" })).toEqual({
      workspace_kind: "remote",
      remote_kind: "",
    });
    expect(resolveWorkspaceTelemetryDetail({ remoteSessionId: "remote-1" })).toEqual({
      workspace_kind: "remote",
      remote_kind: "",
    });
    expect(resolveWorkspaceTelemetryDetail({})).toEqual({
      workspace_kind: "local",
      remote_kind: "",
    });
  });

  it.each<RemoteTarget>([
    { kind: "ssh", host: "host", username: "user" },
    { kind: "wsl", distro: "Ubuntu" },
    { kind: "docker", container: "container" },
    { kind: "server", url: "https://example.test", serverId: "server-1" },
  ])("复用 $kind 远端身份提取", (target) => {
    expect(
      resolveWorkspaceTelemetryDetail({
        workspaceIdentity: buildRemoteWorkspaceIdentity("/repo", target),
      }),
    ).toEqual({ workspace_kind: "remote", remote_kind: target.kind });
  });
});
