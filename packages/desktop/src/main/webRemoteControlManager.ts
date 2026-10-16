import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制 manager 承担外部 relay app payload 路由与 workspace bridge 编排。 */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type ZCodeEndpointUrls,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceTarget,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportAuth,
  type WebRemoteControlDeviceTransportOptions,
  type WebRemoteControlDeviceTransportState,
} from "./webRemoteControlTransport.js";
import type { WebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import type { WebRemoteControlRelayAuthStorageProvider } from "./webRemoteControlRelayAuthStorageProvider.js";
import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";

interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

interface WindowControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  currentBridge?: WorkspaceBridgeRuntime;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlManagerDependencies {
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  authProvider: WebRemoteControlRelayAuthProvider;
  authStorageProvider: WebRemoteControlRelayAuthStorageProvider;
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

// Bugfix: 外部 relay 首次鉴权会受边缘层冷启动和网络抖动影响，实测可能略超 15s。
// 这里等待到 30s，避免在 device 已经快进入 waiting_terminal 时过早销毁可用连接。
const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

function isBridgeableRemoteTask(task: WebRemoteControlTaskTarget): boolean {
  return task.workspaceKind !== "remote" || Boolean(task.workspaceIdentity && task.remoteSessionId);
}

function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

async function resetExternalRelayDeviceAuth(
  authStorageProvider: WebRemoteControlRelayAuthStorageProvider,
  logger: WebRemoteControlManagerDependencies["logger"],
  reason: "manual" | "auth-failed" | "device-not-found" | "leaked-qr",
): Promise<void> {
  await authStorageProvider.clear();
  logger.info("[web-remote-control] external relay auth reset", { reason });
}

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  const runtimes = new Map<number, WindowControlRuntime>();
  const startAuthorizations = new Map<string, WebRemoteControlStartAuthorization>();
  const availableWorkspacesByWindowId = new Map<number, WebRemoteControlWorkspaceTarget[]>();

  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // 埋点是旁路能力，任何异常都不能改变远控配对和 bridge 的业务结果。
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  const availableTasksByWindowId = new Map<number, WebRemoteControlTaskTarget[]>();
  const pushedWorkspaceListSignaturesByWindowId = new Map<number, string>();
  const startupRestoreContextPromise = dependencies.startupRestoreStorageProvider
    .load()
    .catch((error) => {
      dependencies.logger.warn("[web-remote-control] load startup restore context failed", error);
      return undefined;
    });
  let startupRestoreClaimed = false;

  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.windowId === windowId) {
        startAuthorizations.delete(token);
      }
    }
  }

  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // 同一窗口只保留最近一次 IPC dispatch 对应的内部票据，避免旧请求与新 workspace 上下文并存。
    clearStartAuthorizationsForWindow(windowId);
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.expiresAt <= now) {
        startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = startAuthorizations.get(authorization.token);
    startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  function disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void {
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // MessagePortProtocol 已经关闭时 dispose 失败不影响主流程。
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    runtime.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return runtimes.get(runtime.windowId) === runtime && runtime.currentBridge === bridge;
  }

  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    sendAppPayload(runtime, {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    });
  }

  function clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    const target = getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  function schedulePendingOutboundPayloadTimeout(runtime: WindowControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload);
    }
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length >= 50) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  function flushPendingOutboundPayloads(runtime: WindowControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: relay suspect 窗口内 sendPayload 会返回 false。
    // desktop 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(runtime, payload);
  }

  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.error = failure.message;
    runtime.failure = failure;
    runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    emitRuntimeStatus(runtime);
  }

  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    const runtime = runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    runtimes.delete(windowId);
    pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    emitIdleStatus(windowId);
  }

  function getRuntimeWorkspaceTarget(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget {
    const bridge = runtime.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: 手机端可以在同一个远控会话里切到窗口内的其他 workspace。
    // 之前 getStatus() 复用了当前 bridge 目标，导致桌面弹层按启动 workspace 轮询时误判为“不是同一会话”，
    // 再次打开弹层会重启远控并把手机端踢成离线。状态接口保持窗口远控会话的原始目标，
    // 手机当前 workspace 仍通过 mobileViewState / workspace list 表达。
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getAvailableWorkspaces(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    for (const workspace of availableWorkspacesByWindowId.get(runtime.windowId) ?? []) {
      // Bugfix: 手机端 workspace 列表需要和桌面端一致展示已断开的 SSH 项目。
      // 这里仅保留列表项；真正创建 bridge 时仍会校验 remoteSessionId，避免未连接项目被直接打开聊天。
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getRuntimeWorkspaceTarget(runtime);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  function getAvailableTasks(runtime: WindowControlRuntime): WebRemoteControlTaskTarget[] {
    const availableWorkspaceKeys = new Set(
      getAvailableWorkspaces(runtime).map((workspace) =>
        resolveWebRemoteControlWorkspaceKey(workspace),
      ),
    );

    return (availableTasksByWindowId.get(runtime.windowId) ?? [])
      .filter(
        (task) =>
          isBridgeableRemoteTask(task) &&
          availableWorkspaceKeys.has(resolveWebRemoteControlWorkspaceKey(task)),
      )
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        if (right.createdAt !== left.createdAt) {
          return right.createdAt - left.createdAt;
        }
        return right.taskId.localeCompare(left.taskId);
      });
  }

  function getRuntimeInitialViewState(
    runtime: WindowControlRuntime,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  function buildBootstrapResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: runtime.deviceSid,
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      initialViewState: getRuntimeInitialViewState(runtime),
      mobileViewState: runtime.mobileViewState,
    };
  }

  function buildWorkspaceListResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    const initialViewState = getRuntimeInitialViewState(runtime);
    return {
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      activeWorkspaceKey:
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        runtime.mobileViewState?.activeTaskId ??
        runtime.currentBridge?.initialTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix：连接状态不只包含枚举值；同一 disconnected 状态下错误原因也会变化，
          // 手机 workspace card 直接展示 lastConnectionError，必须触发新快照。
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();
    const taskSignatureEntries = result.tasks
      .map((task) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(task);
        return JSON.stringify([
          workspaceKey,
          task.taskId,
          // Bugfix：自动标题和用户重命名不会改变 task identity/membership；标题本身必须参与
          // 首页快照去重，否则手机会一直保留旧文案。
          task.title,
          // Bugfix：远程 workspace 重连后 workspaceKey 可以保持不变，但 task target 绑定的
          // remoteSessionId 会轮换；手机必须采用新连接身份，不能把它当成重复任务。
          task.remoteSessionId ?? "",
          // Bugfix：手机首页状态来自 renderer 已计算的 displayStatus；旧签名只比较 membership，
          // running/completed/error 迁移会被误判为重复快照。缺失值按手机 fallback 归一为 idle。
          task.displayStatus ?? "idle",
          // 后台工作起止决定手机列表运行层归属（排序），displayStatus 不变也要出新快照。
          Boolean(task.hasBackgroundWork),
          // 工作流运行行的数据：phase 灯翻转、run 结束、子代理数变化都要让手机重画那一行。
          task.workflowActivity ?? null,
          // Bugfix：unreadAt 是手机蓝点的事实字段；打开任务清除未读时 task membership 不变，
          // 必须让时间戳到缺失值的迁移触发新快照。
          typeof task.unreadAt === "number" ? task.unreadAt : "",
          Boolean(task.pinned),
          Boolean(task.archived),
        ]);
      })
      .sort();

    // Bugfix：title / connection error 是任意用户可见字符串，不能再用控制字符拼接 tuple；
    // 否则字段值本身包含分隔符时不同快照可能得到相同签名。JSON tuple 保持字段边界且仍忽略数组顺序。
    return JSON.stringify([workspaceSignatureEntries, taskSignatureEntries]);
  }

  function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
    const result = buildWorkspaceListResult(runtime);
    const signature = buildWorkspaceListPushSignature(result);
    if (pushedWorkspaceListSignaturesByWindowId.get(runtime.windowId) === signature) {
      return;
    }

    pushedWorkspaceListSignaturesByWindowId.set(runtime.windowId, signature);
    sendAppPayload(runtime, {
      zcode_type: "workspace-list-updated",
      result,
    });
  }

  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  async function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const target = getAvailableWorkspaces(runtime).find(
      (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
    );
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix：raw adapter 是唯一 replay owner；main 不再把 rpc-frame 放进普通 50 项 buffer。
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      runtime.mobileDeviceInfo = deviceInfo;
    }
  }

  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, frame);
  }

  function routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean {
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: buildBootstrapResult(runtime),
        });
        break;
      case "workspace-list-request":
        sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(runtime),
        });
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；Main 只转发，不维护会话事实或干预 replayable 链路。
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      default:
        break;
    }
  }

  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    if (state === "connecting" || state === "registering" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话的 relay 短抖会先经历 connecting/authenticating。
        // 旧逻辑把 dialog 立刻切成“启动中”，用户会误以为远控重新启动；这里在宽限期内保持 active。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话恢复时 relay 可能短暂回 waiting。
        // 旧逻辑会把 dialog 从 active 拉回“等待手机匹配”；这里先防抖，超时仍未 paired 再降级。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
      // 这里在状态恢复为可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
      flushPendingOutboundPayloads(runtime);
      return;
    }
    if (state === "kicked") {
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      emitRuntimeStatus(runtime);
    }
  }

  function createQrUrl(
    auth: { deviceSid: string; passHash: string },
    mobileRemoteControlUrl: string,
    theme?: WebRemoteControlContext["theme"],
  ): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid: auth.deviceSid,
      passHash: auth.passHash,
      timestamp: Date.now(),
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
      theme,
    });
  }

  return {
    authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.start(windowId, context);
    },
    async start(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      clearStartAuthorizationsForWindow(windowId);
      dependencies.featureGate.assertEnabled();
      startupRestoreClaimed = true;
      await stopWindowRuntime(windowId, "restart");
      const endpointUrls = await dependencies.getEndpointUrls?.();
      const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
      const mobileRemoteControlUrl = endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;

      dependencies.logger.info(
        `[web-remote-control] start window=${windowId} workspace=${context.workspacePath} remoteSession=${context.remoteSessionId ?? "none"} relay=${relayWsUrl}`,
      );

      const storedAuth = await dependencies.authStorageProvider.load();
      const transportAuth: WebRemoteControlDeviceTransportAuth = storedAuth
        ? {
            mode: "persisted",
            deviceSid: storedAuth.deviceSid,
            passHash: storedAuth.passHash,
          }
        : {
            mode: "register",
            passHash: dependencies.authProvider.createPassHash(
              dependencies.authProvider.createPassword(),
            ),
          };
      let readyAuth =
        transportAuth.mode === "persisted"
          ? { deviceSid: transportAuth.deviceSid, passHash: transportAuth.passHash }
          : undefined;
      let registeredAuth: { deviceSid: string; passHash: string } | undefined;
      let runtime: WindowControlRuntime;

      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("External relay device did not reach QR-ready state before timeout."));
        }, EXTERNAL_RELAY_QR_READY_TIMEOUT_MS);

        const resolveReady = () => {
          clearTimeout(timeout);
          resolve();
        };

        const transport = createTransport({
          relayWsUrl,
          deviceMid: dependencies.deviceMid,
          auth: transportAuth,
          meta: {
            platform: process.platform,
            version: dependencies.appVersion,
            name: dependencies.deviceName,
          },
          authProvider: dependencies.authProvider,
          logger: dependencies.logger,
          relayMessageLogger: dependencies.relayMessageLogger,
          onRegisteredAuth: (auth) => {
            registeredAuth = auth;
            readyAuth = auth;
          },
          onStateChange: (state) => {
            mapTransportState(runtime, state);
            if ((state === "waiting_terminal" || state === "paired") && readyAuth) {
              resolveReady();
            }
          },
          onPayload: (payload) => routePayload(runtime, payload),
          onRawTransportPayload: (payload) => routeRawTransportCandidate(runtime, payload),
          onRawTransportFault: (reasonCode) => {
            runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode);
          },
          onSendReady: () => {
            flushPendingOutboundPayloads(runtime);
            const relayProtocol = runtime.currentBridge?.relayProtocol;
            if (!relayProtocol || relayProtocol.isDegraded()) return;
            // Bug 修复：relay 的 matched 只证明当前 peer 可发送，本地 WebSocket 未换代不代表
            // 对端 peer 未换代，也不证明此前 data 已交付。必须重放同 bridge 的未 ACK 批次；
            // adapter 会按 messageSeq 去重，且重放不刷新原始 45 秒 queued age。
            relayProtocol.replayUnacknowledged();
          },
          onError: (error) => {
            dependencies.logger.warn("[web-remote-control] external relay device error", {
              message: error.message,
            });
          },
          onInvalidPersistedAuth: async () => {
            await resetExternalRelayDeviceAuth(
              dependencies.authStorageProvider,
              dependencies.logger,
              "auth-failed",
            );
          },
        });

        runtime = {
          windowId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
          theme: context.theme,
          status: "starting",
          deviceSid: readyAuth?.deviceSid ?? "pending",
          passHash: readyAuth?.passHash ?? transportAuth.passHash,
          deviceMid: dependencies.deviceMid,
          connectUrl: "",
          qrUrl: "",
          transport,
          mobileConnected: false,
          hasEverPaired: false,
          pendingOutboundPayloads: [],
        };
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
        transport.start();
      });

      try {
        await readyPromise;
      } catch (error) {
        runtimes.delete(windowId);
        clearPendingOutboundPayloadTimer(runtime!);
        clearMobileDisconnectGraceTimer(runtime!);
        runtime!.pendingOutboundPayloads.length = 0;
        runtime!.transport.dispose();
        throw error;
      }

      const auth = readyAuth;
      if (!auth) {
        throw new Error("External relay auth was not available after transport became ready.");
      }

      if (registeredAuth) {
        await dependencies.authStorageProvider.save(registeredAuth);
      }

      try {
        await dependencies.startupRestoreStorageProvider.save({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          initialTaskId: context.initialTaskId,
        });
      } catch (error) {
        await stopWindowRuntime(windowId, "startup-restore-persist-failed");
        throw error;
      }

      const qrUrl = createQrUrl(auth, mobileRemoteControlUrl, context.theme);
      runtime!.deviceSid = auth.deviceSid;
      runtime!.passHash = auth.passHash;
      runtime!.qrUrl = qrUrl;
      runtime!.connectUrl = qrUrl;
      emitRuntimeStatus(runtime!);

      return {
        status: runtime!.status === "active" ? "active" : "running",
        sessionId: auth.deviceSid,
        windowControlSessionId: auth.deviceSid,
        qrUrl,
        connectUrl: qrUrl,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        remoteSessionId: context.remoteSessionId,
        initialTaskId: context.initialTaskId,
      };
    },

    async stop(windowId: number): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      // Bugfix: 清除自动恢复设置需要写磁盘，失败时不能阻止用户关闭当前远控连接。
      // 先释放 transport 和 attachment，再把持久化错误返回 UI，保证本次运行立即停止。
      await stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    async suspend(windowId: number, reason: string): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, reason);
    },

    async restorePreviouslyEnabled(
      windowId: number,
      candidates: WebRemoteControlContext[],
    ): Promise<boolean> {
      if (startupRestoreClaimed || runtimes.has(windowId)) {
        return false;
      }

      const persistedContext = await startupRestoreContextPromise;
      if (startupRestoreClaimed || !persistedContext) {
        return false;
      }

      const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
      const currentContext = candidates.find(
        (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
      );
      if (!currentContext) {
        return false;
      }

      startupRestoreClaimed = true;
      dependencies.logger.info(
        `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
      );
      try {
        await this.start(windowId, {
          workspacePath: currentContext.workspacePath,
          workspaceIdentity: currentContext.workspaceIdentity,
          remoteSessionId: currentContext.remoteSessionId,
          initialTaskId: persistedContext.initialTaskId,
        });
        return true;
      } catch (error) {
        startupRestoreClaimed = false;
        dependencies.logger.warn(
          "[web-remote-control] restore previous enabled state failed",
          error,
        );
        return false;
      }
    },

    async resetPairing(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      // Bugfix: refresh 入口和 start 一样受功能开关保护。
      // 之前 gate 校验藏在后续 start 里，feature disabled 时会先清掉本地配对材料再抛错。
      // 这里前置校验，避免禁用态 IPC 产生破坏性副作用。
      dependencies.featureGate.assertEnabled();
      // Bugfix: 二维码 URL 里携带的 sid/hash 泄露后，重启当前 runtime 仍会复用持久化配对材料。
      // 这里必须先关闭旧连接并清掉本地 relay auth，再重新注册设备，确保旧 URL 不再代表当前桌面端会话。
      await stopWindowRuntime(windowId, "leaked-qr");
      await resetExternalRelayDeviceAuth(
        dependencies.authStorageProvider,
        dependencies.logger,
        "leaked-qr",
      );
      return this.start(windowId, context);
    },
    async resetPairingAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.resetPairing(windowId, context);
    },

    getStatus(windowId: number): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      availableWorkspacesByWindowId.set(windowId, workspaces);
      pushWorkspaceListUpdated(runtime);
    },

    syncAvailableTasks(windowId: number, tasks: WebRemoteControlTaskTarget[]): void {
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      availableTasksByWindowId.set(windowId, tasks);
      pushWorkspaceListUpdated(runtime);
    },

    async disposeWindow(windowId: number): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, "window-disposed");
      availableWorkspacesByWindowId.delete(windowId);
      availableTasksByWindowId.delete(windowId);
      pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;

        if (!bridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }

        // Bugfix: 远程 workspace session 只是某个 workspace/bridge 的依赖，不能把它的断开升级成
        // 窗口级 Web 远控 device WS 失败；否则单个远端空闲退出会错误关闭电脑端全局远控入口。
        if (bridgeUsesRemoteSession) {
          disposeRuntimeBridgeResources(runtime);
          sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
        }
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        runtime.status = runtime.mobileConnected ? "active" : "running";
        runtime.error = undefined;
        runtime.failure = undefined;
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
