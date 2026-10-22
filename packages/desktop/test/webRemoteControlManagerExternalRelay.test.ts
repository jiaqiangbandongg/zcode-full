import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  HostPreparedProjectWorkspace,
  HostProjectWorkspaceNavigationInput,
  WebRemoteControlAppPayload,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import {
  parseWebRemoteControlAppPayload,
  buildZCodeEndpointUrls,
  encodeWebRemoteControlRpcTransportMessage,
} from "@zcode/shared";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";

function createFakePort() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
}

type AttachWorkspaceHost = Parameters<
  typeof createWebRemoteControlManager
>[0]["attachWorkspaceHost"];

function createManagerHarness(options?: {
  featureEnabled?: boolean;
  delayReadyMs?: number;
  canSendPayload?: () => boolean;
  startupRestoreContext?: NonNullable<AppSettings["webRemoteControlLastEnabledContext"]>;
  startupRestoreClearError?: Error;
  attachWorkspaceHost?: AttachWorkspaceHost;
  releaseWorkspaceHostAttachment?: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow?: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession?: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  reconnectWorkspace?: (windowId: number, workspaceKey: string) => Promise<void>;
  prepareProjectWorkspace?: (
    windowId: number,
    project: HostProjectWorkspaceNavigationInput,
    requestId: string,
  ) => Promise<HostPreparedProjectWorkspace>;
  onStatusChanged?: Parameters<typeof createWebRemoteControlManager>[0]["onStatusChanged"];
  getEndpointUrls?: Parameters<typeof createWebRemoteControlManager>[0]["getEndpointUrls"];
  reportRemoteUsageEvent?: Parameters<
    typeof createWebRemoteControlManager
  >[0]["reportRemoteUsageEvent"];
}) {
  const sentPayloads: WebRemoteControlAppPayload[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const settings: AppSettings = { recentProjects: [], locale: "zh-CN" };
  const endpointOrigin = async () =>
    (await options?.getEndpointUrls?.())?.origin ?? "https://zcode.z.ai";
  let startupRestoreContext = options?.startupRestoreContext;
  let transportStartCount = 0;
  let deliverPayload: ((payload: WebRemoteControlAppPayload) => void) | undefined;
  let latestTransportOptions:
    | Parameters<
        NonNullable<Parameters<typeof createWebRemoteControlManager>[0]["createDeviceTransport"]>
      >[0]
    | undefined;
  let emitTransportState:
    | Parameters<
        NonNullable<Parameters<typeof createWebRemoteControlManager>[0]["createDeviceTransport"]>
      >[0]["onStateChange"]
    | undefined;
  const disposeTransport = vi.fn();
  const reportRemoteUsageEvent = options?.reportRemoteUsageEvent ?? vi.fn();
  const reportRendererTelemetryEvent = vi.fn();
  const defaultAttachWorkspaceHost = vi.fn(async () => ({
    entryId: "entry-1",
    attachmentId: "attachment-1",
    process: {} as never,
    port: createFakePort() as never,
  }));
  const releaseWorkspaceHostAttachment = options?.releaseWorkspaceHostAttachment ?? vi.fn();
  const disposeWorkspaceHostAttachmentsForWindow =
    options?.disposeWorkspaceHostAttachmentsForWindow ?? vi.fn();
  const disposeWorkspaceHostAttachmentsForRemoteSession =
    options?.disposeWorkspaceHostAttachmentsForRemoteSession ?? vi.fn();
  const manager = createWebRemoteControlManager({
    relayWsUrl: "ws://relay.test/ws",
    mobileRemoteControlUrl: "https://zcode.z.ai/remote/v3",
    getEndpointUrls: options?.getEndpointUrls,
    deviceMid: "mid-1",
    deviceName: "MacBook",
    appVersion: "1.5.0",
    getLogin: async () => ({ userId: "user", jwt: "jwt" }),
    deviceStorage: {
      load: async () => ({
        deviceSid: "sid-1",
        userId: "user",
        endpointOrigin: await endpointOrigin(),
      }),
      save: async (device) => {
        settings.webRemoteControlRelayV2Device = device;
      },
      clearLegacy: async () => {},
    },
    startupRestoreStorageProvider: {
      load: async () => startupRestoreContext,
      save: async (context) => {
        startupRestoreContext = context;
      },
      clear: async () => {
        if (options?.startupRestoreClearError) {
          throw options.startupRestoreClearError;
        }
        startupRestoreContext = undefined;
      },
    },
    featureGate: createWebRemoteControlFeatureGate(options?.featureEnabled ?? true),
    logger,
    platformHandlers: {
      isDockerAvailable: async () => true,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: options?.reconnectWorkspace ?? vi.fn(async () => undefined),
    prepareProjectWorkspace: options?.prepareProjectWorkspace,
    reportRemoteUsageEvent,
    reportRendererTelemetryEvent,
    attachWorkspaceHost: options?.attachWorkspaceHost ?? defaultAttachWorkspaceHost,
    releaseWorkspaceHostAttachment,
    disposeWorkspaceHostAttachmentsForWindow,
    disposeWorkspaceHostAttachmentsForRemoteSession,
    onStatusChanged: options?.onStatusChanged,
    createDeviceTransport: (transportOptions) => ({
      start: () => {
        latestTransportOptions = transportOptions;
        transportStartCount += 1;
        emitTransportState = transportOptions.onStateChange;
        const markReady = async () => {
          await transportOptions.resolveDeviceSid(new AbortController().signal, false);
          deliverPayload = transportOptions.onPayload;
          transportOptions.onStateChange("waiting_terminal");
        };
        if (options?.delayReadyMs !== undefined) {
          setTimeout(markReady, options.delayReadyMs);
          return;
        }
        void markReady();
      },
      sendPayload: (payload) => {
        if (options?.canSendPayload && !options.canSendPayload()) {
          return false;
        }
        sentPayloads.push(payload);
        return true;
      },
      measurePayloadBytes: (payload) => JSON.stringify(payload).length,
      sendPayloadResult: (payload) => {
        if (options?.canSendPayload && !options.canSendPayload()) {
          return { kind: "unavailable" as const };
        }
        sentPayloads.push(payload);
        return { kind: "sent" as const, bytes: JSON.stringify(payload).length };
      },
      dispose: disposeTransport,
    }),
  });

  return {
    defaultAttachWorkspaceHost,
    disposeWorkspaceHostAttachmentsForRemoteSession,
    disposeWorkspaceHostAttachmentsForWindow,
    disposeTransport,
    manager,
    logger,
    releaseWorkspaceHostAttachment,
    reportRemoteUsageEvent,
    reportRendererTelemetryEvent,
    sentPayloads,
    getStartupRestoreContext: () => startupRestoreContext,
    getLatestTransportOptions: () => latestTransportOptions,
    deliverPayload: (payload: WebRemoteControlAppPayload) => {
      if (!deliverPayload) {
        throw new Error("transport not started");
      }
      deliverPayload(payload);
    },
    emitTransportState: (state: Parameters<NonNullable<typeof emitTransportState>>[0]) => {
      if (!emitTransportState) {
        throw new Error("transport not started");
      }
      emitTransportState(state);
    },
    emitTransportSendReady: (kind: "same-socket" | "reconnected-socket") => {
      if (!latestTransportOptions?.onSendReady) {
        throw new Error("transport not started");
      }
      latestTransportOptions.onSendReady({ kind });
    },
  };
}

const localWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/demo",
  label: "demo",
  kind: "local",
};

const remoteWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/remote",
  workspaceIdentity: "remote:ssh:host:/workspace/remote",
  remoteSessionId: "remote-session-1",
  label: "remote",
  kind: "remote",
  connectionState: "connected",
};

async function createPrimedWorkspaceSyncHarness(
  workspaceOverrides: Partial<WebRemoteControlWorkspaceTarget> = {},
) {
  const harness = createManagerHarness();
  await harness.manager.start(1, { workspacePath: localWorkspace.workspacePath });
  const workspace = { ...remoteWorkspace, ...workspaceOverrides };
  harness.manager.syncAvailableWorkspaces(1, [workspace]);
  harness.sentPayloads.length = 0;
  return { ...harness, workspace };
}

describe("createWebRemoteControlManager external relay", () => {
  it("returns the desktop's own version before a workspace bridge is attached", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath: localWorkspace.workspacePath });
    h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "version-check" });
    expect(h.sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bootstrap-response",
        requestId: "version-check",
        result: expect.objectContaining({ desktopAppVersion: "1.5.0" }),
      }),
    );
    expect(h.defaultAttachWorkspaceHost).not.toHaveBeenCalled();
    await h.manager.stop(1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("授权票据绑定窗口与工作区，并且只能消费一次", async () => {
    const { manager } = createManagerHarness();
    const context = { workspacePath: localWorkspace.workspacePath };
    const authorization = manager.authorizeStart(1, context);

    await manager.startAuthorized(1, context, authorization);
    await expect(manager.startAuthorized(1, context, authorization)).rejects.toThrow(
      "already used",
    );
    await manager.stop(1);
  });

  it("停止窗口远控时会作废尚未消费的授权票据", async () => {
    const { manager } = createManagerHarness();
    const context = { workspacePath: localWorkspace.workspacePath };
    const authorization = manager.authorizeStart(1, context);

    await manager.stop(1);

    await expect(manager.startAuthorized(1, context, authorization)).rejects.toThrow("invalid");
  });

  it("授权票据拒绝窗口或 workspace 目标不匹配", async () => {
    const { manager } = createManagerHarness();
    const context = { workspacePath: localWorkspace.workspacePath };
    const authorization = manager.authorizeStart(1, context);

    await expect(manager.startAuthorized(2, context, authorization)).rejects.toThrow(
      "target mismatch",
    );
    await expect(manager.startAuthorized(1, context, authorization)).rejects.toThrow(
      "already used",
    );
  });

  it("授权票据超过短 TTL 后不可消费", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00Z"));
    const { manager } = createManagerHarness();
    const context = { workspacePath: localWorkspace.workspacePath };
    const authorization = manager.authorizeStart(1, context);

    vi.advanceTimersByTime(30_001);

    await expect(manager.startAuthorized(1, context, authorization)).rejects.toThrow("expired");
  });

  it("按首次配对和重连上报低频配对成功事件", async () => {
    const { emitTransportState, manager, reportRemoteUsageEvent } = createManagerHarness();

    await manager.start(1, { workspacePath: localWorkspace.workspacePath });
    emitTransportState("paired");
    emitTransportState("connecting");
    emitTransportState("paired");

    expect(reportRemoteUsageEvent).toHaveBeenNthCalledWith(1, 1, {
      elementName: "web_remote_control_pair_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        pair_kind: "initial",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "",
      },
    });
    expect(reportRemoteUsageEvent).toHaveBeenNthCalledWith(2, 1, {
      elementName: "web_remote_control_pair_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        pair_kind: "reconnect",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "",
      },
    });
  });

  it("在远程 shared-host attachment 成功后上报 bridge 实际使用", async () => {
    const attachWorkspaceHost = vi.fn(async () => ({
      entryId: "entry-remote",
      attachmentId: "attachment-remote",
      process: {} as never,
      port: createFakePort() as never,
      remoteKind: "ssh" as const,
    }));
    const { deliverPayload, manager, reportRemoteUsageEvent } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, {
      workspacePath: remoteWorkspace.workspacePath,
      workspaceIdentity: remoteWorkspace.workspaceIdentity,
      remoteSessionId: remoteWorkspace.remoteSessionId,
    });
    manager.syncAvailableWorkspaces(1, [remoteWorkspace]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-request-remote",
      bridgeSessionId: "bridge-remote",
      workspaceKey: remoteWorkspace.workspaceIdentity!,
      taskId: "task-1",
    });

    await vi.waitFor(() =>
      expect(reportRemoteUsageEvent).toHaveBeenCalledWith(1, {
        elementName: "web_remote_control_bridge_result",
        eventRegion: "web_remote_control",
        eventType: "result",
        eventExtraDetail: {
          result: "success",
          workspace_kind: "remote",
          remote_kind: "ssh",
          entry_kind: "task",
          error_category: "",
        },
      }),
    );
  });

  it("bridge 失败只上报错误分类，不泄漏原始目标信息", async () => {
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => {
      throw Object.assign(new Error("secret-host.example.com attach failed"), {
        code: "REMOTE_SESSION_MISSING",
      });
    });
    const { deliverPayload, manager, reportRemoteUsageEvent } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, { workspacePath: localWorkspace.workspacePath });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-request-failed",
      bridgeSessionId: "bridge-failed",
      workspaceKey: localWorkspace.workspacePath,
    });

    await vi.waitFor(() =>
      expect(reportRemoteUsageEvent).toHaveBeenCalledWith(1, {
        elementName: "web_remote_control_bridge_result",
        eventRegion: "web_remote_control",
        eventType: "result",
        eventExtraDetail: {
          result: "failure",
          workspace_kind: "local",
          remote_kind: "",
          entry_kind: "home",
          error_category: "attach",
        },
      }),
    );
    expect(JSON.stringify(reportRemoteUsageEvent.mock.calls)).not.toContain(
      "secret-host.example.com",
    );
  });

  it("matches remote workspace bridge requests by workspace identity and strips legacy bridge fields", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);

    const status = manager.getStatus(1);
    expect(status.qrUrl).toContain("/remote/v3?");

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open" as const,
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-1",
          bridge: expect.objectContaining({
            kind: "remote",
            workspaceKey: "remote:ssh:host:/workspace/demo",
            workspaceIdentity: "remote:ssh:host:/workspace/demo",
            capabilities: { windowProjectDirectory: true },
          }),
        }),
      );
    });
    const readyPayload = sentPayloads.find(
      (payload) => payload.zcode_type === "workspace-bridge-ready",
    );
    expect(JSON.stringify(readyPayload)).not.toContain("bridgeToken");
    expect(JSON.stringify(readyPayload)).not.toContain("wsUrl");
  });

  it("uses the current endpoint resolver for relay and QR URL on each start", async () => {
    const { getLatestTransportOptions, manager } = createManagerHarness({
      getEndpointUrls: () => buildZCodeEndpointUrls("http://localhost:3030"),
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    const status = manager.getStatus(1);

    expect(getLatestTransportOptions()?.relayWsUrl).toBe("ws://localhost:3030/api/v1/remote/ws2");
    expect(status.qrUrl).toContain("http://localhost:3030/remote/v3?");
  });

  it("does not append theme params to the mobile QR URL", async () => {
    const { manager } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      theme: "zai-dark",
    });

    const status = manager.getStatus(1);
    expect(status.qrUrl).not.toContain("theme=");
  });

  it("persists successful enablement and clears it only after an explicit stop", async () => {
    const { getStartupRestoreContext, manager } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "ephemeral-session",
      initialTaskId: "task-1",
      theme: "zai-dark",
    });

    expect(getStartupRestoreContext()).toEqual({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    });

    await manager.suspend(1, "endpoint-changed");
    expect(getStartupRestoreContext()).toEqual({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    });

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "ephemeral-session",
      initialTaskId: "task-1",
    });

    await manager.disposeWindow(1);
    expect(getStartupRestoreContext()).toEqual({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    });

    await manager.stop(1);
    expect(getStartupRestoreContext()).toBeUndefined();
  });

  it("stops the active runtime when clearing startup recovery state fails", async () => {
    const { disposeTransport, disposeWorkspaceHostAttachmentsForWindow, manager } =
      createManagerHarness({
        startupRestoreClearError: new Error("settings write failed"),
      });
    await manager.start(1, { workspacePath: "/workspace/demo" });

    await expect(manager.stop(1)).rejects.toThrow("settings write failed");

    expect(manager.getStatus(1)).toEqual({ status: "idle" });
    expect(disposeTransport).toHaveBeenCalledOnce();
    expect(disposeWorkspaceHostAttachmentsForWindow).toHaveBeenCalledWith(1, "manual-stop");
  });

  it("restores the previous target only after its current workspace context is available", async () => {
    const { getStartupRestoreContext, getLatestTransportOptions, manager } = createManagerHarness({
      startupRestoreContext: {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        initialTaskId: "task-1",
      },
    });

    await expect(
      manager.restorePreviouslyEnabled(1, [{ workspacePath: "/workspace/other" }]),
    ).resolves.toBe(false);
    expect(manager.getStatus(1)).toEqual({ status: "idle" });

    await expect(
      manager.restorePreviouslyEnabled(1, [
        {
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:host:/workspace/demo",
          remoteSessionId: "current-session",
        },
      ]),
    ).resolves.toBe(true);

    expect(manager.getStatus(1)).toEqual(
      expect.objectContaining({
        status: "running",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "current-session",
        initialTaskId: "task-1",
      }),
    );
    expect(getLatestTransportOptions()).toBeDefined();
    expect(getStartupRestoreContext()).toEqual({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    });
  });

  it("releases only the previous attachment when mobile reconnects to the same workspace", async () => {
    let nextAttachmentId = 0;
    const attachWorkspaceHost = vi.fn(async () => ({
      entryId: "entry-1",
      attachmentId: `attachment-${++nextAttachmentId}`,
      process: {} as never,
      port: createFakePort() as never,
    }));
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      releaseWorkspaceHostAttachment,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
      taskId: "task-1",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-1" })),
    );

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-2",
      bridgeSessionId: "bridge-2",
      workspaceKey: "/workspace/demo",
      taskId: "task-1",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-2" })),
    );

    expect(attachWorkspaceHost).toHaveBeenCalledTimes(2);
    expect(attachWorkspaceHost).toHaveBeenLastCalledWith(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: undefined,
      remoteSessionId: undefined,
      initialTaskId: "task-1",
      kind: "local",
    });
    expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");
  });

  it("lists disconnected remote workspaces but does not create a bridge before reconnect", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start(1, { workspacePath: "/workspace/local" });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/remote",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        label: "remote",
        kind: "remote",
        connectionState: "disconnected",
        lastConnectionError: "ssh closed",
      },
    ]);

    sentPayloads.length = 0;
    deliverPayload({ zcode_type: "workspace-list-request", requestId: "list-1" });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-list-response",
          result: expect.objectContaining({
            workspaces: expect.arrayContaining([
              expect.objectContaining({
                workspaceIdentity: "remote:ssh:host:/workspace/remote",
                connectionState: "disconnected",
                lastConnectionError: "ssh closed",
              }),
            ]),
          }),
        }),
      ),
    );

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-req-1",
      bridgeSessionId: "bridge-disconnected",
      workspaceKey: "remote:ssh:host:/workspace/remote",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          bridgeSessionId: "bridge-disconnected",
        }),
      ),
    );
  });

  it.each([
    ["connectionState", {}, { connectionState: "reconnecting" }],
    ["remoteSessionId", {}, { remoteSessionId: "remote-session-2" }],
    [
      "lastConnectionError",
      { connectionState: "disconnected", lastConnectionError: "ssh closed" },
      { lastConnectionError: "authentication failed" },
    ],
  ] satisfies Array<
    [string, Partial<WebRemoteControlWorkspaceTarget>, Partial<WebRemoteControlWorkspaceTarget>]
  >)("pushes workspace list updates when workspace %s changes", async (_field, initial, patch) => {
    const { manager, sentPayloads, workspace } = await createPrimedWorkspaceSyncHarness(initial);

    manager.syncAvailableWorkspaces(1, [{ ...workspace, ...patch }]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          workspaces: expect.arrayContaining([
            expect.objectContaining({
              workspaceIdentity: workspace.workspaceIdentity,
              ...patch,
            }),
          ]),
        }),
      }),
    );
  });

  it("forwards mobile workspace reconnect requests to the desktop renderer", async () => {
    const reconnectWorkspace = vi.fn(async () => undefined);
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      reconnectWorkspace,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });

    deliverPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "reconnect-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual({
        zcode_type: "workspace-reconnect-response",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:host:/workspace/demo",
        success: true,
      }),
    );
    expect(reconnectWorkspace).toHaveBeenCalledWith(1, "remote:ssh:host:/workspace/demo");
  });

  it("releases stale attachments when an older bridge open completes after reconnect", async () => {
    let resolveFirst: ((value: Awaited<ReturnType<AttachWorkspaceHost>>) => void) | undefined;
    const attachWorkspaceHost = vi
      .fn<AttachWorkspaceHost>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        entryId: "entry-1",
        attachmentId: "attachment-2",
        process: {} as never,
        port: createFakePort() as never,
      });
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      releaseWorkspaceHostAttachment,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-2",
      bridgeSessionId: "bridge-2",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-2" })),
    );

    resolveFirst?.({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: createFakePort() as never,
    });

    await vi.waitFor(() =>
      expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1"),
    );
    expect(releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith("");
    expect(
      sentPayloads.filter(
        (payload) =>
          payload.zcode_type === "workspace-bridge-ready" && payload.bridgeSessionId === "bridge-1",
      ),
    ).toEqual([]);
  });

  it("does not match a remote workspace by path when identity is present", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-path",
      bridgeSessionId: "bridge-path",
      workspaceKey: "/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: "req-path",
        }),
      );
    });
  });

  it.each([
    ["DESKTOP_HOST_MISSING", "desktop-disconnected"],
    ["REMOTE_SESSION_MISSING", "workspace-closed"],
    ["REMOTE_WORKSPACE_IDENTITY_MISSING", "unsupported-action"],
  ] as const)("maps workspace bridge attach error %s to %s", async (code, reason) => {
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => {
      throw Object.assign(new Error(`attach failed: ${code}`), { code });
    });
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: `req-${code}`,
      bridgeSessionId: `bridge-${code}`,
      workspaceKey: "/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: `req-${code}`,
          bridgeSessionId: `bridge-${code}`,
          reason,
        }),
      );
    });
  });

  it("production feature gate rejects start before returning QR material", async () => {
    const { manager } = createManagerHarness({ featureEnabled: false });

    await expect(
      manager.start(1, {
        workspacePath: "/workspace/demo",
      }),
    ).rejects.toThrow("Web remote control is disabled");
    expect(manager.getStatus(1)).toEqual({
      status: "idle",
      failure: {
        reason: "unsupported-action",
        message: "Web remote control is disabled in this build.",
      },
    });
  });

  it("waits long enough for slow external relay QR readiness", async () => {
    vi.useFakeTimers();
    const { manager } = createManagerHarness({ delayReadyMs: 20_000 });

    const startPromise = manager.start(1, {
      workspacePath: "/workspace/demo",
    });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(startPromise).resolves.toMatchObject({
      status: "running",
      sessionId: "sid-1",
    });
    expect(manager.getStatus(1)).toMatchObject({
      status: "running",
      sessionId: "sid-1",
    });
  });

  it("emits a status update as soon as the external relay session is ready", async () => {
    const onStatusChanged = vi.fn();
    const { manager } = createManagerHarness({ onStatusChanged });

    await manager.start(1, {
      workspacePath: "/workspace/demo",
    });

    expect(onStatusChanged).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "running",
        sessionId: "sid-1",
        qrUrl: expect.stringContaining("/remote/v3?"),
      }),
    );
  });

  it("keeps the dialog active during a short paired-session reconnect", async () => {
    vi.useFakeTimers();
    const { emitTransportState, manager } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
    });
    emitTransportState("paired");
    expect(manager.getStatus(1)).toMatchObject({
      status: "active",
      mobileConnected: true,
    });

    emitTransportState("connecting");
    expect(manager.getStatus(1)).toMatchObject({
      status: "active",
      mobileConnected: true,
    });

    emitTransportState("waiting_terminal");
    expect(manager.getStatus(1)).toMatchObject({
      status: "active",
      mobileConnected: true,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(manager.getStatus(1)).toMatchObject({
      status: "running",
      mobileConnected: false,
    });
  });

  it("flushes buffered outbound payloads after a normal reconnect becomes paired", async () => {
    let canSendPayload = true;
    const { deliverPayload, emitTransportState, manager, sentPayloads } = createManagerHarness({
      canSendPayload: () => canSendPayload,
    });

    await manager.start(1, {
      workspacePath: "/workspace/demo",
    });
    emitTransportState("paired");
    sentPayloads.length = 0;

    canSendPayload = false;
    deliverPayload({
      zcode_type: "workspace-list-request",
      requestId: "req-buffered",
    });
    expect(sentPayloads).toEqual([]);

    canSendPayload = true;
    emitTransportState("connecting");
    emitTransportState("authenticating");
    emitTransportState("paired");

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-response",
        requestId: "req-buffered",
      }),
    );
  });

  it("drops duplicate mobile rpc frames before forwarding to the host", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    deliverPayload(frame);
    deliverPayload(frame);

    expect(hostPort.postMessage).toHaveBeenCalledTimes(1);
  });

  it("marks a bridge degraded and does not forward mobile rpc frame gaps", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    const [gapFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([2]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 2,
      messageSeq: 1,
    });
    deliverPayload(gapFrame);

    expect(hostPort.postMessage).not.toHaveBeenCalled();
    expect(sentPayloads).toContainEqual({
      zcode_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      reason: "rpc-transport-fault",
    });
  });

  it("keeps raw bridge frames out of the ordinary 50-item buffer", async () => {
    let canSendPayload = true;
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({
        attachWorkspaceHost,
        canSendPayload: () => canSendPayload,
      });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    canSendPayload = false;
    for (let index = 0; index < 51; index += 1) {
      hostPort.emit("message", { data: new Uint8Array([index]) });
    }

    canSendPayload = true;
    emitTransportSendReady("same-socket");

    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(51);
    expect(sentPayloads.some((payload) => payload.zcode_type === "bridge-degraded")).toBe(false);
  });

  it("does not apply the ordinary app buffer timeout to raw bridge frames", async () => {
    vi.useFakeTimers();
    let canSendPayload = true;
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({
        attachWorkspaceHost,
        canSendPayload: () => canSendPayload,
      });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    canSendPayload = false;
    hostPort.emit("message", { data: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(5_000);

    canSendPayload = true;
    emitTransportSendReady("same-socket");

    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(1);
    expect(sentPayloads.some((payload) => payload.zcode_type === "bridge-degraded")).toBe(false);
  });

  it("replays lost-ACK raw frames after same-socket peer readiness and stops after cumulative ACK", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({ attachWorkspaceHost });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    hostPort.emit("message", { data: new Uint8Array([1, 2, 3]) });
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(1);
    const firstFrame = sentPayloads[0];

    emitTransportSendReady("same-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(2);
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")[1]).toBe(
      firstFrame,
    );

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "foreign-bridge",
      ackMessageSeq: 1,
    });
    emitTransportSendReady("reconnected-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(3);

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-1",
      ackMessageSeq: 1,
    });
    emitTransportSendReady("reconnected-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(3);
  });

  it("forwards raw adapter saturated/drained edges only to the owning host attachment", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportState, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-flow",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    hostPort.emit("message", { data: new Uint8Array(900_000) });
    expect(hostPort.postMessage).toHaveBeenCalledWith({
      __zcodeRpcControl: "connection-flow-v1",
      state: "saturated",
    });

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-flow",
      ackMessageSeq: 1,
    });
    expect(hostPort.postMessage).toHaveBeenCalledWith({
      __zcodeRpcControl: "connection-flow-v1",
      state: "drained",
    });
  });

  it("exposes the latest mobile device info from view state updates", async () => {
    const { deliverPayload, manager } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
    });

    deliverPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: "/workspace/demo",
        activeTaskId: "task-1",
        updatedAt: 1,
      },
      deviceInfo: {
        platform: "web",
        version: "1.7.0",
        name: "mobile-browser",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        language: "zh-CN",
        languages: ["zh-CN", "en-US"],
        browserPlatform: "iPhone",
        viewport: {
          width: 390,
          height: 844,
          devicePixelRatio: 3,
        },
        screen: {
          width: 390,
          height: 844,
        },
        timezone: "Asia/Shanghai",
        online: true,
        updatedAt: 2,
      },
    });

    expect(manager.getStatus(1)).toMatchObject({
      mobileViewState: {
        activeWorkspaceKey: "/workspace/demo",
        activeTaskId: "task-1",
      },
      mobileDeviceInfo: {
        platform: "web",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        viewport: {
          width: 390,
          height: 844,
        },
      },
    });
  });

  it("手机 session_create 保留来源和手机 context，宿主只转发一次", async () => {
    const { deliverPayload, manager, reportRendererTelemetryEvent } = createManagerHarness();
    await manager.start(1, { workspacePath: "/workspace/demo" });
    const event = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: "s1",
      messageId: "mobile-first-command",
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "390x844",
      },
      eventExtraDetail: {
        create_source: "session",
        client_kind: "mobile",
        workspace_kind: "remote",
        remote_kind: "ssh",
      },
    } as const;
    deliverPayload({ zcode_type: "telemetry-report", event });
    expect(reportRendererTelemetryEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("logs mobile diagnostics as desktop log summaries", async () => {
    const { deliverPayload, logger, manager } = createManagerHarness();

    await manager.start(1, {
      workspacePath: "/workspace/demo",
    });

    deliverPayload({
      zcode_type: "mobile-diagnostic",
      event: "pair-status",
      timestamp: 1710000000000,
      state: "paired",
      pairStatus: "waiting",
      visibilityState: "visible",
      online: true,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "[web-remote-control] mobile diagnostic",
      expect.objectContaining({
        event: "pair-status",
        pairStatus: "waiting",
        state: "paired",
        visibilityState: "visible",
        online: true,
      }),
    );
  });

  it("keeps the dialog status target on the window workspace after mobile opens another workspace bridge", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start(1, { workspacePath: "/workspace/z-code" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/z-code", label: "z-code", kind: "local" },
      { workspacePath: "/workspace/cgx-dev-web", label: "cgx-dev-web", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-cgx",
      bridgeSessionId: "bridge-cgx",
      workspaceKey: "/workspace/cgx-dev-web",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-cgx",
        }),
      ),
    );

    expect(manager.getStatus(1)).toMatchObject({
      status: "active",
      workspacePath: "/workspace/z-code",
    });
  });

  it("disposes workspace host attachments when stopping the window runtime", async () => {
    const disposeWorkspaceHostAttachmentsForWindow = vi.fn();
    const { manager } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForWindow,
    });

    await manager.start(1, { workspacePath: "/workspace/demo" });
    await manager.stop(1);

    expect(disposeWorkspaceHostAttachmentsForWindow).toHaveBeenCalledWith(1, "manual-stop");
  });

  it("disposes workspace host attachments when a remote session fails", async () => {
    const disposeWorkspaceHostAttachmentsForRemoteSession = vi.fn();
    const { deliverPayload, manager } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForRemoteSession,
    });

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });
    await vi.waitFor(() => expect(manager.getStatus(1).status).toBe("active"));

    manager.failRemoteSession("remote-session-1", "remote-closed", {
      reason: "workspace-closed",
      message: "closed",
    });

    expect(disposeWorkspaceHostAttachmentsForRemoteSession).toHaveBeenCalledWith(
      "remote-session-1",
      "remote-closed",
    );
  });

  it("degrades an active remote bridge after Source reconnect so Web opens a new transport generation", async () => {
    let attachment = 0;
    const attachWorkspaceHost = vi.fn(async () => ({
      entryId: `entry-${++attachment}`,
      attachmentId: `attachment-${attachment}`,
      process: {} as never,
      port: createFakePort() as never,
    }));
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      releaseWorkspaceHostAttachment,
    });
    const workspaceIdentity = "remote:server:source-1:/workspace/demo";

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity,
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity,
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 4,
      recoveryId: "recovery-1",
      workspaceKey: workspaceIdentity,
    });
    await vi.waitFor(() => expect(manager.getStatus(1).status).toBe("active"));
    sentPayloads.length = 0;

    await manager.replaceRemoteSession({
      previousSessionId: "remote-session-1",
      sessionId: "remote-session-2",
      workspacePath: "/workspace/demo",
      workspaceIdentity,
    });

    expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");
    expect(attachWorkspaceHost).toHaveBeenCalledTimes(1);
    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 4,
        recoveryId: "recovery-1",
        reason: "source-session-replaced",
      }),
    );
    expect(sentPayloads).not.toContainEqual(
      expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
    );
  });

  it("replays Source replacement invalidation after the ordinary app buffer deadline", async () => {
    vi.useFakeTimers();
    let canSendPayload = true;
    let attachment = 0;
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, emitTransportSendReady, manager, sentPayloads } = createManagerHarness({
      canSendPayload: () => canSendPayload,
      releaseWorkspaceHostAttachment,
      attachWorkspaceHost: vi.fn(async () => ({
        entryId: `entry-${++attachment}`,
        attachmentId: `attachment-${attachment}`,
        process: {} as never,
        port: createFakePort() as never,
      })),
    });
    const workspaceIdentity = "remote:server:source-1:/workspace/demo";
    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity,
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity,
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: workspaceIdentity,
    });
    await vi.waitFor(() => expect(manager.getStatus(1).status).toBe("active"));
    sentPayloads.length = 0;
    canSendPayload = false;

    await manager.replaceRemoteSession({
      previousSessionId: "remote-session-1",
      sessionId: "remote-session-2",
      workspacePath: "/workspace/demo",
      workspaceIdentity,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentPayloads).toEqual([]);
    expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");

    canSendPayload = true;
    emitTransportSendReady("same-socket");

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        reason: "source-session-replaced",
      }),
    );

    const firstReplayCount = sentPayloads.filter(
      (payload) => payload.zcode_type === "bridge-degraded",
    ).length;
    emitTransportSendReady("same-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "bridge-degraded")).toHaveLength(
      firstReplayCount,
    );

    emitTransportSendReady("reconnected-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "bridge-degraded")).toHaveLength(
      firstReplayCount + 1,
    );
  });

  it("keeps the desktop relay session alive when a waiting remote workspace session closes", async () => {
    const disposeWorkspaceHostAttachmentsForRemoteSession = vi.fn();
    const { disposeTransport, manager, sentPayloads } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForRemoteSession,
    });

    await manager.start(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });

    manager.failRemoteSession("remote-session-1", "remote-closed", {
      reason: "workspace-closed",
      message: "closed",
    });

    expect(manager.getStatus(1)).toMatchObject({
      status: "running",
      failure: undefined,
    });
    expect(disposeTransport).not.toHaveBeenCalled();
    expect(sentPayloads).not.toContainEqual(expect.objectContaining({ zcode_type: "app-error" }));
    expect(disposeWorkspaceHostAttachmentsForRemoteSession).toHaveBeenCalledWith(
      "remote-session-1",
      "remote-closed",
    );
  });
});

describe("mobile project bridge admission", () => {
  const prepared: HostPreparedProjectWorkspace = {
    projectId: "project-a",
    hostId: "server:source-a",
    workspacePath: "/new-project",
    workspaceIdentity: "remote:server:source-a:/new-project",
    additionalDirectories: [],
    remote: {
      remoteSessionId: "project-scope",
      sourceServerId: "source-a",
      generation: 1,
      target: { kind: "server", url: "http://source.test" },
      workspacePath: "/new-project",
      workspaceIdentity: "remote:server:source-a:/new-project",
    },
  };
  const projectRequest = {
    zcode_type: "workspace-bridge-open" as const,
    requestId: "project-request",
    bridgeSessionId: "project-bridge",
    workspaceKey: localWorkspace.workspacePath,
    project: { projectId: "project-a", hostId: "server:source-a" },
  };
  it("attaches the Host admitted directory even without a desktop tab", async () => {
    const prepareProjectWorkspace = vi.fn(async () => prepared);
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    harness.manager.syncAvailableWorkspaces(1, [localWorkspace]);
    harness.deliverPayload(projectRequest);
    await vi.waitFor(() =>
      expect(harness.defaultAttachWorkspaceHost).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          workspacePath: prepared.workspacePath,
          workspaceIdentity: prepared.workspaceIdentity,
          remoteSessionId: "project-scope",
          kind: "remote",
        }),
      ),
    );
    expect(prepareProjectWorkspace).toHaveBeenCalledOnce();
    expect(prepareProjectWorkspace).toHaveBeenCalledWith(
      1,
      projectRequest.project,
      expect.any(String),
    );
    await harness.manager.disposeWindow(1);
  });
  it("keeps the current bridge when the Host refuses project admission", async () => {
    const prepareProjectWorkspace = vi.fn(async () => {
      throw new Error("Source offline");
    });
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    harness.manager.syncAvailableWorkspaces(1, [localWorkspace]);
    harness.deliverPayload({
      ...projectRequest,
      project: undefined,
      bridgeSessionId: "old-bridge",
    });
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "old-bridge",
        }),
      ),
    );
    harness.deliverPayload(projectRequest);
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          bridgeSessionId: "project-bridge",
          error: "Source offline",
        }),
      ),
    );
    expect(harness.releaseWorkspaceHostAttachment).not.toHaveBeenCalled();
    await harness.manager.disposeWindow(1);
  });
  it("deduplicates project preparation across transport retries", async () => {
    let finish!: (result: HostPreparedProjectWorkspace) => void;
    const prepareProjectWorkspace = vi.fn(
      () =>
        new Promise<HostPreparedProjectWorkspace>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    harness.deliverPayload(projectRequest);
    harness.deliverPayload({ ...projectRequest, requestId: "retry" });
    await vi.waitFor(() => expect(prepareProjectWorkspace).toHaveBeenCalledOnce());
    finish(prepared);
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready", requestId: "retry" }),
      ),
    );
    harness.deliverPayload({ ...projectRequest, requestId: "retry-after-ready" });
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          requestId: "retry-after-ready",
        }),
      ),
    );
    expect(prepareProjectWorkspace).toHaveBeenCalledOnce();
    expect(harness.defaultAttachWorkspaceHost).toHaveBeenCalledOnce();
    await harness.manager.disposeWindow(1);
  });
  it("does not let a late project result supersede a later ordinary navigation", async () => {
    let finish!: (result: HostPreparedProjectWorkspace) => void;
    const prepareProjectWorkspace = vi.fn(
      () =>
        new Promise<HostPreparedProjectWorkspace>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    harness.manager.syncAvailableWorkspaces(1, [localWorkspace]);
    harness.deliverPayload(projectRequest);
    await vi.waitFor(() => expect(prepareProjectWorkspace).toHaveBeenCalledOnce());
    harness.deliverPayload({
      ...projectRequest,
      project: undefined,
      bridgeSessionId: "later-bridge",
      requestId: "later",
    });
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "later-bridge",
        }),
      ),
    );
    finish(prepared);
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: "project-request",
        }),
      ),
    );
    expect(harness.defaultAttachWorkspaceHost).toHaveBeenCalledOnce();
    await harness.manager.disposeWindow(1);
  });
  it("rejects a retry for the invalidated bridge after Source replacement", async () => {
    const harness = createManagerHarness({ prepareProjectWorkspace: async () => prepared });
    await harness.manager.start(1, localWorkspace);
    harness.deliverPayload(projectRequest);
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          requestId: "project-request",
        }),
      ),
    );
    await harness.manager.replaceRemoteSession({
      previousSessionId: "project-scope",
      sessionId: "replacement",
      workspacePath: prepared.workspacePath,
      workspaceIdentity: prepared.workspaceIdentity!,
    });
    harness.deliverPayload({ ...projectRequest, requestId: "invalidated-retry" });
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: "invalidated-retry",
        }),
      ),
    );
    await harness.manager.disposeWindow(1);
  });
  it("admits a file-only task cwd without selecting or marking the task read", async () => {
    const prepareProjectWorkspace = vi.fn(async () => prepared);
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    const request = {
      ...projectRequest,
      project: undefined,
      workspaceKey: prepared.workspaceIdentity!,
      fileTreeTaskId: "existing-task",
      taskHostId: prepared.hostId,
    };
    expect(parseWebRemoteControlAppPayload(request)).toEqual(request);
    harness.deliverPayload(request);
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridge: expect.objectContaining({ workspacePath: prepared.workspacePath }),
        }),
      ),
    );
    const response = harness.sentPayloads.find(
      (payload) => payload.zcode_type === "workspace-bridge-ready",
    );
    expect(
      response && response.zcode_type === "workspace-bridge-ready" && response.bridge.initialTaskId,
    ).toBeUndefined();
    expect(prepareProjectWorkspace).toHaveBeenCalledWith(
      1,
      {
        hostId: prepared.hostId,
        task: { taskId: "existing-task", workspaceKey: prepared.workspaceIdentity },
      },
      expect.any(String),
    );
    expect(parseWebRemoteControlAppPayload({ ...request, taskId: "other" })).toBeNull();
    expect(parseWebRemoteControlAppPayload({ ...request, taskHostId: undefined })).toBeNull();
    await harness.manager.disposeWindow(1);
  });
  it("admits an existing project task absent from the desktop workspace list", async () => {
    const prepareProjectWorkspace = vi.fn(async () => prepared);
    const harness = createManagerHarness({ prepareProjectWorkspace });
    await harness.manager.start(1, localWorkspace);
    harness.deliverPayload({
      ...projectRequest,
      project: undefined,
      workspaceKey: prepared.workspaceIdentity!,
      taskId: "existing-task",
      taskHostId: prepared.hostId,
    });
    await vi.waitFor(() =>
      expect(harness.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridge: expect.objectContaining({
            initialTaskId: "existing-task",
            workspacePath: prepared.workspacePath,
          }),
        }),
      ),
    );
    expect(prepareProjectWorkspace).toHaveBeenCalledWith(
      1,
      {
        hostId: prepared.hostId,
        task: { taskId: "existing-task", workspaceKey: prepared.workspaceIdentity },
      },
      expect.any(String),
    );
    await harness.manager.disposeWindow(1);
  });
});

async function createTaskViewHarness() {
  const onStatusChanged = vi.fn();
  const harness = createManagerHarness({ onStatusChanged });
  await harness.manager.start(1, { workspacePath: localWorkspace.workspacePath });
  harness.manager.syncAvailableWorkspaces(1, [remoteWorkspace]);
  harness.emitTransportState("paired");
  const epoch = () => {
    const request = harness.sentPayloads.findLast(
      (payload) => payload.zcode_type === "mobile-task-view-request",
    );
    expect(request).toBeDefined();
    if (!request || request.zcode_type !== "mobile-task-view-request")
      throw new Error("missing task view epoch");
    return request.epoch;
  };
  const open = async (bridgeSessionId = "view-bridge", bridgeGeneration = 1) => {
    harness.deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: bridgeSessionId,
      bridgeSessionId,
      bridgeGeneration,
      workspaceKey: remoteWorkspace.workspaceIdentity!,
    });
    await vi.waitFor(() =>
      expect(
        harness.sentPayloads.some(
          (payload) =>
            payload.zcode_type === "workspace-bridge-ready" &&
            payload.bridgeSessionId === bridgeSessionId,
        ),
      ).toBe(true),
    );
  };
  await open();
  const view = {
    workspacePath: remoteWorkspace.workspacePath,
    workspaceIdentity: remoteWorkspace.workspaceIdentity,
    taskId: "view-task",
  };
  const send = (
    seq: number,
    value: typeof view | null = view,
    overrides: Record<string, unknown> = {},
  ) =>
    harness.deliverPayload({
      zcode_type: "mobile-task-view-update",
      epoch: epoch(),
      seq,
      bridgeSessionId: "view-bridge",
      bridgeGeneration: 1,
      view: value,
      ...overrides,
    } as never);
  return { ...harness, onStatusChanged, epoch, open, view, send };
}

it("MRO03：查看进入和离开同步推送，旧导航位置不能被当作有效查看", async () => {
  const f = await createTaskViewHarness();
  try {
    f.deliverPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: remoteWorkspace.workspaceIdentity,
        activeTaskId: "cached",
        updatedAt: 1,
      },
    });
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    f.onStatusChanged.mockClear();
    f.send(1);
    f.send(2);
    f.send(3, null);
    expect(f.onStatusChanged.mock.calls.map(([, status]) => status.mobileTaskView)).toEqual([
      { ...f.view, remoteSessionId: remoteWorkspace.remoteSessionId },
      null,
    ]);
    expect(f.manager.getStatus(1).mobileViewState?.activeTaskId).toBe("cached");
  } finally {
    await f.manager.stop(1);
  }
});

it("MRO03：断线立即清查看但保留连接宽限，重连只接收新 epoch", async () => {
  const f = await createTaskViewHarness();
  try {
    f.send(1);
    const previous = f.epoch();
    f.emitTransportState("connecting");
    expect(f.manager.getStatus(1)).toMatchObject({ mobileConnected: true, mobileTaskView: null });
    f.emitTransportState("paired");
    expect(f.epoch()).not.toBe(previous);
    f.send(99, f.view, { epoch: previous });
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    f.send(1);
    expect(f.manager.getStatus(1).mobileTaskView).toEqual({
      ...f.view,
      remoteSessionId: remoteWorkspace.remoteSessionId,
    });
  } finally {
    await f.manager.stop(1);
  }
});

it("MRO03：旧序号、bridge 代际、同路径异设备及错 cwd 不能替换查看事实", async () => {
  const f = await createTaskViewHarness();
  try {
    f.send(5);
    f.send(4, null);
    f.send(6, null, { bridgeSessionId: "old" });
    f.send(6, null, { bridgeGeneration: 0 });
    f.send(6, { ...f.view, workspaceIdentity: "remote:server:other:/workspace/remote" });
    f.send(6, { ...f.view, workspacePath: "/other" });
    expect(f.manager.getStatus(1).mobileTaskView).toEqual({
      ...f.view,
      remoteSessionId: remoteWorkspace.remoteSessionId,
    });
    f.send(6, null);
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    f.send(7);
    await f.open("next-view-bridge", 2);
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    f.send(8);
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
  } finally {
    await f.manager.stop(1);
  }
});

it("MRO03：bootstrap 补发 epoch，send-ready 不以心跳频率重申查看", async () => {
  const f = await createTaskViewHarness();
  try {
    const epoch = f.epoch();
    f.deliverPayload({ zcode_type: "bootstrap-request", requestId: "view-bootstrap" });
    expect(f.sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bootstrap-response",
        requestId: "view-bootstrap",
        result: expect.objectContaining({ mobileTaskViewEpoch: epoch }),
      }),
    );
    f.emitTransportSendReady("same-socket");
    const count = f.sentPayloads.filter(
      (payload) => payload.zcode_type === "mobile-task-view-request",
    ).length;
    f.emitTransportSendReady("same-socket");
    expect(
      f.sentPayloads.filter((payload) => payload.zcode_type === "mobile-task-view-request"),
    ).toHaveLength(count);
    f.emitTransportSendReady("reconnected-socket");
    expect(
      f.sentPayloads.filter((payload) => payload.zcode_type === "mobile-task-view-request"),
    ).toHaveLength(count + 1);
  } finally {
    await f.manager.stop(1);
  }
});

it.each(["raw-fault", "replaced", "closed"] as const)(
  "MRO03：连接仍 paired 时 bridge 失效立即清查看：%s",
  async (reason) => {
    const f = await createTaskViewHarness();
    try {
      f.send(1);
      if (reason === "raw-fault")
        f.getLatestTransportOptions()?.onRawTransportFault?.("invalid-frame");
      else if (reason === "closed")
        f.manager.failRemoteSession(remoteWorkspace.remoteSessionId!, "test", {
          reason: "workspace-closed",
        });
      else
        await f.manager.replaceRemoteSession({
          previousSessionId: remoteWorkspace.remoteSessionId!,
          sessionId: "new-session",
          workspacePath: remoteWorkspace.workspacePath,
          workspaceIdentity: remoteWorkspace.workspaceIdentity!,
        });
      expect(f.manager.getStatus(1)).toMatchObject({ mobileConnected: true, mobileTaskView: null });
      f.send(2);
      expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    } finally {
      await f.manager.stop(1);
    }
  },
);

it("MRO03：legacy 身份的查看事实由 Main 注入当前 session，换代不能沿用旧 session", async () => {
  const f = await createTaskViewHarness();
  try {
    f.send(1);
    expect(f.manager.getStatus(1).mobileTaskView).toEqual({
      ...f.view,
      remoteSessionId: remoteWorkspace.remoteSessionId,
    });
    await f.manager.replaceRemoteSession({
      previousSessionId: remoteWorkspace.remoteSessionId!,
      sessionId: "replacement-session",
      workspacePath: remoteWorkspace.workspacePath,
      workspaceIdentity: remoteWorkspace.workspaceIdentity!,
    });
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    await f.open("replacement-view-bridge", 2);
    f.send(2);
    expect(f.manager.getStatus(1).mobileTaskView).toBeNull();
    f.send(3, f.view, { bridgeSessionId: "replacement-view-bridge", bridgeGeneration: 2 });
    expect(f.manager.getStatus(1).mobileTaskView).toEqual({
      ...f.view,
      remoteSessionId: "replacement-session",
    });
  } finally {
    await f.manager.stop(1);
  }
});
