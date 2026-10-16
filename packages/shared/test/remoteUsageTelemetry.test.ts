import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceConnectResultTelemetry,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlEntryViewTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  buildWebRemoteControlStartResultTelemetry,
  classifyRemoteUsageError,
} from "../src/remoteUsageTelemetry.js";

describe("remote usage telemetry", () => {
  it("构造远程工作区连接终态事件且不携带目标身份信息", () => {
    const event = buildRemoteWorkspaceConnectResultTelemetry({
      result: "success",
      remoteKind: "ssh",
      connectTrigger: "reconnect",
    });

    expect(event).toEqual({
      elementName: "remote_workspace_connect_result",
      eventRegion: "remote_workspace",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        remote_kind: "ssh",
        connect_trigger: "reconnect",
        error_category: "",
      },
    });
    expect(event.eventExtraDetail).not.toHaveProperty("workspacePath");
    expect(event.eventExtraDetail).not.toHaveProperty("workspaceIdentity");
    expect(event.eventExtraDetail).not.toHaveProperty("remoteSessionId");
  });

  it("构造 Web Remote Control 生命周期事件", () => {
    expect(
      buildWebRemoteControlEntryViewTelemetry({
        workspaceKind: "remote",
        remoteKind: "ssh",
      }),
    ).toEqual({
      elementName: "web_remote_control_entry_view",
      eventRegion: "web_remote_control",
      eventType: "view",
      eventExtraDetail: {
        workspace_kind: "remote",
        remote_kind: "ssh",
      },
    });
    expect(
      buildWebRemoteControlStartResultTelemetry({
        result: "failure",
        workspaceKind: "local",
        errorCategory: "relay",
      }),
    ).toMatchObject({
      elementName: "web_remote_control_start_result",
      eventExtraDetail: {
        result: "failure",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "relay",
      },
    });
    expect(
      buildWebRemoteControlStartResultTelemetry({
        result: "cancelled",
        workspaceKind: "remote",
        remoteKind: "ssh",
      }),
    ).toMatchObject({
      elementName: "web_remote_control_start_result",
      eventExtraDetail: {
        result: "cancelled",
        workspace_kind: "remote",
        remote_kind: "ssh",
        error_category: "",
      },
    });
    expect(
      buildWebRemoteControlPairResultTelemetry({
        result: "success",
        pairKind: "reconnect",
        workspaceKind: "remote",
        remoteKind: "wsl",
      }),
    ).toMatchObject({
      elementName: "web_remote_control_pair_result",
      eventExtraDetail: {
        result: "success",
        pair_kind: "reconnect",
        workspace_kind: "remote",
        remote_kind: "wsl",
        error_category: "",
      },
    });
    expect(
      buildWebRemoteControlBridgeResultTelemetry({
        result: "success",
        workspaceKind: "remote",
        remoteKind: "docker",
        entryKind: "task",
      }),
    ).toMatchObject({
      elementName: "web_remote_control_bridge_result",
      eventExtraDetail: {
        result: "success",
        workspace_kind: "remote",
        remote_kind: "docker",
        entry_kind: "task",
        error_category: "",
      },
    });
  });

  it.each([
    [Object.assign(new Error("password rejected"), { code: "AUTH_FAILED" }), "auth"],
    [Object.assign(new Error("asset install failed"), { code: "DEPLOY_FAILED" }), "deploy"],
    [Object.assign(new Error("spawn host failed"), { code: "HOST_START_FAILED" }), "host_start"],
    [
      Object.assign(new Error("secret workspace missing"), { code: "REMOTE_SESSION_MISSING" }),
      "attach",
    ],
    [Object.assign(new Error("desktop unavailable"), { code: "DESKTOP_HOST_MISSING" }), "attach"],
    [Object.assign(new Error("relay websocket closed"), { code: "RELAY_CLOSED" }), "relay"],
    [Object.assign(new Error("ssh timeout"), { code: "ETIMEDOUT" }), "connect"],
    [new Error("包含私密目标但无法分类"), "unknown"],
  ] as const)("只把错误映射为低基数枚举 %#", (error, expected) => {
    expect(classifyRemoteUsageError(error)).toBe(expected);
  });
});
