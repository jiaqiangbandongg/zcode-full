import { describe, expect, it } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "../src/channels.js";
import {
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
  windowHostAttachmentScopeSchema,
} from "../src/validation.js";

const sshTarget = {
  kind: "ssh" as const,
  host: "dev.internal",
  username: "developer",
};

describe("R1 window Host control protocol", () => {
  it("validates monotonic-shape CUA PiP focus facts", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "cua-pip-focus-changed",
        event: {
          kind: "focus-changed",
          revision: 3,
          sourceWindowId: "window-7",
          sessionId: "session-a",
        },
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "cua-pip-focus-changed",
        event: {
          kind: "focus-changed",
          revision: -1,
          sourceWindowId: "window-7",
          sessionId: null,
        },
      }).success,
    ).toBe(false);
  });
  it("接受带 requestId 的远程连接、取消、绑定和释放请求", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: "connect-1",
        target: sshTarget,
        remoteAssets: {},
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: "connect-1",
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.BindRemoteWorkspaceContext,
        requestId: "bind-1",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: "dispose-1",
        remoteSessionId: "remote-session-1",
      }).success,
    ).toBe(true);
  });

  it("所有异步控制请求都拒绝空 requestId", () => {
    const requests = [
      {
        type: HostMessageTypes.ConnectRemoteWorkspace,
        target: sshTarget,
        remoteAssets: {},
      },
      { type: HostMessageTypes.CancelRemoteWorkspaceConnect },
      {
        type: HostMessageTypes.BindRemoteWorkspaceContext,
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      {
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        remoteSessionId: "remote-session-1",
      },
    ];

    for (const request of requests) {
      expect(hostIncomingMessageSchema.safeParse(request).success).toBe(false);
      expect(hostIncomingMessageSchema.safeParse({ ...request, requestId: "" }).success).toBe(
        false,
      );
    }
  });

  it("remote attachment scope 强制携带完整 session、path 和 identity", () => {
    expect(windowHostAttachmentScopeSchema.safeParse({ kind: "local" }).success).toBe(true);
    expect(
      windowHostAttachmentScopeSchema.safeParse({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }).success,
    ).toBe(true);
    expect(
      windowHostAttachmentScopeSchema.safeParse({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
      }).success,
    ).toBe(false);
  });

  it("AttachServicePort 同时校验可信 clientMode 和 scope", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.AttachServicePort,
        requestId: "attach-local-1",
        attachmentId: "attachment-local-1",
        clientMode: "desktop-continuous",
        scope: { kind: "local" },
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.AttachServicePort,
        requestId: "attach-remote-1",
        attachmentId: "attachment-remote-1",
        clientMode: "web-remote-replayable",
        scope: {
          kind: "remote",
          remoteSessionId: "remote-session-1",
          workspacePath: "/work/demo",
          workspaceIdentity: "remote:ssh:dev:/work/demo",
        },
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.AttachServicePort,
        requestId: "attach-forged-1",
        attachmentId: "attachment-forged-1",
        clientMode: "mobile-self-declared",
        scope: { kind: "local" },
      }).success,
    ).toBe(false);
  });

  it("接受严格的连接进度、成功、失败和关闭事件", () => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId: "connect-1",
        level: "info",
        message: "detecting remote env...",
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceConnected,
        requestId: "connect-1",
        descriptor: {
          remoteSessionId: "remote-session-1",
          target: sshTarget,
          workspacePath: "/work/demo",
          workspaceIdentity: "remote:ssh:dev:/work/demo",
          generation: 1,
        },
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceConnectFailed,
        requestId: "connect-1",
        error: "authentication failed",
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceClosed,
        remoteSessionId: "remote-session-1",
        reason: "connection-closed",
        exitCode: 255,
        signal: null,
      }).success,
    ).toBe(true);
  });

  it("严格校验 Remote Environment Provisioning 的执行与结果消息", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.ProviderProvisioningExecute,
        requestId: "provisioning-1",
        environmentKey: "ssh:dev.internal:developer",
        remoteSessionId: "remote-session-1",
        trigger: "environment-online",
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.ProviderProvisioningExecute,
        requestId: "provisioning-1",
        environmentKey: "",
        remoteSessionId: "remote-session-1",
        trigger: "manual",
      }).success,
    ).toBe(false);

    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.ProviderProvisioningSourceChanged,
        trigger: "credential",
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.ProviderProvisioningSourceChanged,
        trigger: "environment-online",
      }).success,
    ).toBe(false);

    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: "provisioning-1",
        environmentKey: "ssh:dev.internal:developer",
        status: "applied",
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: "provisioning-1",
        environmentKey: "ssh:dev.internal:developer",
        status: "partially-applied",
      }).success,
    ).toBe(false);
  });

  it("严格校验 host 自采资源样本（cpu / rss / heap 三项齐全且为数值）", () => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.HostResourceSample,
        sample: { cpuPercent: 3.5, rssKb: 380_000, heapUsedKb: 91_234 },
      }).success,
    ).toBe(true);
    // 字段缺失：main 入口直接丢弃该样本。
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.HostResourceSample,
        sample: { cpuPercent: 3.5, rssKb: 380_000 },
      }).success,
    ).toBe(false);
    // 类型错误。
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.HostResourceSample,
        sample: { cpuPercent: "3.5", rssKb: 380_000, heapUsedKb: 91_234 },
      }).success,
    ).toBe(false);
    // 多余字段：Host 自采样本只带这三项，隐私红线不允许夹带 pid 之类的维度。
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.HostResourceSample,
        sample: { cpuPercent: 3.5, rssKb: 380_000, heapUsedKb: 91_234, pid: 4_321 },
      }).success,
    ).toBe(false);
  });

  it("拒绝包含未知字段的 R1 控制消息和事件", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: "connect-1",
        remoteSessionId: "forged-session",
      }).success,
    ).toBe(false);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceConnectFailed,
        requestId: "connect-1",
        error: "failed",
        target: sshTarget,
      }).success,
    ).toBe(false);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId: "",
        level: "debug",
        message: "forged",
      }).success,
    ).toBe(false);
  });
});
