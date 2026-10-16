import type { MobileSessionCreateTelemetry } from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- Web 远程控制共享协议同时保留旧 /web-remote 类型和新外部 relay 类型，后续拆分时再按 transport/app payload 分文件。 */
import type { DockerContainerInfo, SSHConfigAliasOption, WSLDistro } from "./platform.js";
import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
} from "./platform.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { SessionWorkflowActivity } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import type { WebRemoteControlRpcTransportPayload } from "./web-remote-control-rpc-transport.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";

export const WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS = 120_000;
export const WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS = 5_000;

export type WebRemoteControlThemeSeed = "light" | "dark" | "zai-light" | "zai-dark" | "system";

export interface WebRemoteControlContext {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlThemeSeed;
}

export type WebRemoteControlStatusKind =
  | "idle"
  | "starting"
  | "running"
  | "connecting"
  | "active"
  | "error";

export type WebRemoteControlFailureReason =
  | "session-not-found"
  | "session-expired"
  | "session-conflict"
  | "workspace-closed"
  | "desktop-disconnected"
  | "invalid-mobile-connection"
  | "desktop-bootstrap-timeout"
  | "connection-recovery-timeout"
  | "relay-unavailable"
  | "unsupported-action"
  | "unexpected-error";

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
}

export function createWebRemoteControlConnectionRecoveryTimeoutFailure(
  message: string,
): WebRemoteControlFailure {
  return {
    // Bugfix: 手机端长时间后台后恢复超时，真实问题是手机连接未恢复，
    // 不能映射成 desktop-disconnected，否则错误页会误导用户以为电脑端离线。
    reason: "connection-recovery-timeout",
    message,
  };
}

export interface WebRemoteControlRelayDeviceMeta {
  platform: string;
  version: string;
  name: string;
}

export interface WebRemoteControlMobileViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface WebRemoteControlMobileScreenInfo {
  width: number;
  height: number;
}

export interface WebRemoteControlMobileDeviceInfo extends WebRemoteControlRelayDeviceMeta {
  userAgent?: string;
  language?: string;
  languages?: string[];
  browserPlatform?: string;
  viewport?: WebRemoteControlMobileViewportInfo;
  screen?: WebRemoteControlMobileScreenInfo;
  timezone?: string;
  online?: boolean;
  updatedAt: number;
}

export type WebRemoteControlRelayRole = "device" | "terminal";
// Bugfix: zcode-remote-hub 当前只会把配对状态表示为 waiting/matched；
// KICKED、WRONG_PARAM 等是 error code，不是 pair_status。这里收窄共享类型，
// 避免客户端把不存在的 rejected/kicked 配对状态误判成桌面端 WS 需要关闭。
export type WebRemoteControlRelayPairStatus = "waiting" | "matched";
export type WebRemoteControlRelayErrorCode =
  | "AUTH_FAILED"
  | "DEVICE_OFFLINE"
  | "KICKED"
  | "WRONG_PARAM"
  | "INTERNAL";

export interface WebRemoteControlRelayOutgoingBase {
  client_ts?: number;
}

export interface WebRemoteControlRelayIncomingBase {
  server_ts?: number;
}

export interface WebRemoteControlRelayDeviceRegisterInit extends WebRemoteControlRelayOutgoingBase {
  type: "device_register_init";
  device_mid: string;
  pass_hash: string;
  meta: WebRemoteControlRelayDeviceMeta;
}

export interface WebRemoteControlRelayDeviceRegisterAck extends WebRemoteControlRelayIncomingBase {
  type: "device_register_ack";
  device_sid: string;
}

export interface WebRemoteControlRelayAuthInit extends WebRemoteControlRelayOutgoingBase {
  type: "auth_init";
  role: WebRemoteControlRelayRole;
  device_sid: string;
  meta: WebRemoteControlRelayDeviceMeta;
}

export interface WebRemoteControlRelayAuthChallenge extends WebRemoteControlRelayIncomingBase {
  type: "auth_challenge";
  nonce: string;
}

export interface WebRemoteControlRelayAuthResponse extends WebRemoteControlRelayOutgoingBase {
  type: "auth_response";
  device_sid: string;
  proof: string;
}

export interface WebRemoteControlRelayAuthAck extends WebRemoteControlRelayIncomingBase {
  type: "auth_ack";
  device_sid: string;
  terminal_sid?: string;
  pair_status: WebRemoteControlRelayPairStatus;
}

export interface WebRemoteControlRelayPairStatusQuery extends WebRemoteControlRelayOutgoingBase {
  type: "pair_status_query";
  device_sid: string;
}

export interface WebRemoteControlRelayPairStatusAck extends WebRemoteControlRelayIncomingBase {
  type: "pair_status_ack";
  terminal_sid?: string;
  pair_status: WebRemoteControlRelayPairStatus;
}

export interface WebRemoteControlRelayDataMessage<TPayload = unknown>
  extends WebRemoteControlRelayOutgoingBase, WebRemoteControlRelayIncomingBase {
  type: "data";
  payload: TPayload;
}

export interface WebRemoteControlRelayError extends WebRemoteControlRelayIncomingBase {
  type: "error";
  code: WebRemoteControlRelayErrorCode;
  message: string;
}

export type WebRemoteControlRelayOutgoingMessage =
  | WebRemoteControlRelayDeviceRegisterInit
  | WebRemoteControlRelayAuthInit
  | WebRemoteControlRelayAuthResponse
  | WebRemoteControlRelayPairStatusQuery
  | WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload>;

export type WebRemoteControlRelayIncomingMessage =
  | WebRemoteControlRelayDeviceRegisterAck
  | WebRemoteControlRelayAuthChallenge
  | WebRemoteControlRelayAuthAck
  | WebRemoteControlRelayPairStatusAck
  | WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload>
  | WebRemoteControlRelayError;

export interface WebRemoteControlRelayAuthProofVector {
  passHash: string;
  nonce: string;
  role: WebRemoteControlRelayRole;
  deviceSid: string;
  proof: string;
}

export const WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS: WebRemoteControlRelayAuthProofVector[] = [
  {
    passHash: "dGVzdF9oYXNo",
    nonce: "nonce-1",
    role: "device",
    deviceSid: "device-1",
    proof: "XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE",
  },
  {
    passHash: "dGVzdF9oYXNo",
    nonce: "nonce-1",
    role: "terminal",
    deviceSid: "device-1",
    proof: "YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU",
  },
];

export interface WebRemoteControlExternalQrParams {
  deviceSid: string;
  passHash: string;
  timestamp: number;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
  theme?: WebRemoteControlThemeSeed;
}

export interface BuildWebRemoteControlExternalQrUrlOptions extends WebRemoteControlExternalQrParams {
  baseUrl: string;
}

function readNonEmptySearchParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

export function isWebRemoteControlThemeSeed(value: unknown): value is WebRemoteControlThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

export function resolveWebRemoteControlRoutePathFromBaseUrl(baseUrl: string): string {
  const rawBaseUrl = baseUrl.trim() || "/";
  let pathname = "/";

  try {
    pathname = new URL(rawBaseUrl, "https://zcode.invalid").pathname;
  } catch {
    pathname = rawBaseUrl.startsWith("/") ? rawBaseUrl : `/${rawBaseUrl}`;
  }

  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/") {
    return "/remote";
  }
  return normalizedPathname;
}

export function matchesWebRemoteControlRoutePath(pathname: string, routePath: string): boolean {
  // Bugfix: dev / production 入口可能带 /remote/ 尾斜杠；
  // 路由判断需要接受 /remote 与 /remote/，但不能把 /remote/favicon.ico 当成应用入口。
  const normalizeRoutePath = (value: string) => value.replace(/\/+$/, "") || "/";
  return normalizeRoutePath(pathname) === normalizeRoutePath(routePath);
}

export function buildWebRemoteControlExternalQrUrl({
  baseUrl,
  deviceSid,
  passHash,
  timestamp,
  deviceMid,
  deviceName,
  appVersion,
  theme,
}: BuildWebRemoteControlExternalQrUrlOptions): string {
  const url = new URL(baseUrl);
  url.searchParams.set("sid", deviceSid);
  url.searchParams.set("hash", passHash);
  url.searchParams.set("t", String(timestamp));

  if (deviceMid?.trim()) {
    url.searchParams.set("mid", deviceMid);
  }
  if (deviceName?.trim()) {
    url.searchParams.set("name", deviceName);
  }
  if (appVersion?.trim()) {
    url.searchParams.set("app_version", appVersion);
  }
  void theme;
  // Bugfix: 手机端主题现在固定走本地默认 dark，不再通过二维码 URL 透传 theme。
  // 之前 theme 参数会把桌面端主题耦合到手机首次进入行为，后续维护和排障都更复杂。
  // 这里保留入参仅做向后兼容，避免旧调用点一次性改动过大。

  return url.toString();
}

export function parseWebRemoteControlExternalQrParams(
  params: URLSearchParams,
): WebRemoteControlExternalQrParams | null {
  const deviceSid = readNonEmptySearchParam(params, "sid");
  const passHash = readNonEmptySearchParam(params, "hash");
  const rawTimestamp = readNonEmptySearchParam(params, "t");
  const timestamp = rawTimestamp ? Number(rawTimestamp) : Number.NaN;
  const theme = readNonEmptySearchParam(params, "theme");

  if (!deviceSid || !passHash || !Number.isFinite(timestamp)) {
    return null;
  }

  return {
    deviceSid,
    passHash,
    timestamp,
    ...(readNonEmptySearchParam(params, "mid")
      ? { deviceMid: readNonEmptySearchParam(params, "mid") }
      : {}),
    ...(readNonEmptySearchParam(params, "name")
      ? { deviceName: readNonEmptySearchParam(params, "name") }
      : {}),
    ...(readNonEmptySearchParam(params, "app_version")
      ? { appVersion: readNonEmptySearchParam(params, "app_version") }
      : {}),
    ...(isWebRemoteControlThemeSeed(theme) ? { theme } : {}),
  };
}

export type WebRemoteControlTokenKind = "window-pairing";

export type WebRemoteControlWindowFailureReason = WebRemoteControlFailureReason;

export const WebRemoteControlCloseCodes = {
  SessionNotFound: 4004,
  SessionConflict: 4009,
  DesktopDisconnected: 4010,
  SessionExpired: 4011,
  WorkspaceClosed: 4012,
  InvalidMobileConnection: 4013,
} as const;

export function resolveWebRemoteControlFailureReasonFromCloseCode(
  code: number,
): WebRemoteControlFailureReason | null {
  switch (code) {
    case WebRemoteControlCloseCodes.SessionNotFound:
      return "session-not-found";
    case WebRemoteControlCloseCodes.SessionConflict:
      return "session-conflict";
    case WebRemoteControlCloseCodes.DesktopDisconnected:
      return "desktop-disconnected";
    case WebRemoteControlCloseCodes.SessionExpired:
      return "session-expired";
    case WebRemoteControlCloseCodes.WorkspaceClosed:
      return "workspace-closed";
    case WebRemoteControlCloseCodes.InvalidMobileConnection:
      return "invalid-mobile-connection";
    default:
      return null;
  }
}

export interface WebRemoteControlStartResult {
  status: Extract<WebRemoteControlStatusKind, "running" | "connecting" | "active">;
  sessionId: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  qrUrl: string;
  connectUrl: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartCancelledResult {
  status: "cancelled";
}

/** 兼容仍可返回取消终态的平台实现；当前 Desktop 启动和刷新链路不会产生该结果。 */
export type WebRemoteControlStartOperationResult =
  | WebRemoteControlStartResult
  | WebRemoteControlStartCancelledResult;

export interface WebRemoteControlStatus {
  status: WebRemoteControlStatusKind;
  sessionId?: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  mobileConnected?: boolean;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  qrUrl?: string;
  connectUrl?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  error?: string;
  failure?: WebRemoteControlFailure;
}

export interface WebRemoteControlSessionCreateRequest {
  tunnelId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlSessionCreateResponse extends WebRemoteControlStartResult {
  token: string;
}

export interface WebRemoteControlWindowSession {
  windowControlSessionId: string;
  deviceToken: string;
  tokenKind: WebRemoteControlTokenKind;
  connectUrl: string;
  qrUrl: string;
  expiresAt: number;
  status: "idle" | "starting" | "running" | "active" | "error";
}

export interface WebRemoteControlBootstrapResult {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlBootstrapErrorResponse {
  error: string;
  reason: WebRemoteControlFailureReason;
}

export interface WebRemoteControlPlatformMethodArgsMap {
  isDockerAvailable: undefined;
  listWSLDistros: undefined;
  listDockerContainers: undefined;
  listSSHConfigAliases: undefined;
  createTempTextAttachment: CreateTempTextAttachmentRequest;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryRequest | undefined;
  saveMcpToUserDirectory: SaveCliMcpToUserDirectoryRequest;
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpRequest | undefined;
}

export interface WebRemoteControlPlatformMethodResultMap {
  isDockerAvailable: boolean;
  listWSLDistros: WSLDistro[];
  listDockerContainers: DockerContainerInfo[];
  listSSHConfigAliases: SSHConfigAliasOption[];
  createTempTextAttachment: CreateTempTextAttachmentResult;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryResult;
  saveMcpToUserDirectory: { success: boolean; error?: string };
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpResult;
}

export type WebRemoteControlPlatformMethod = keyof WebRemoteControlPlatformMethodResultMap;

export type WebRemoteControlPlatformRequest = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformSuccessResponse = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-response";
    requestId: string;
    method: K;
    success: true;
    result: WebRemoteControlPlatformMethodResultMap[K];
  };
}[WebRemoteControlPlatformMethod];

export interface WebRemoteControlPlatformErrorResponse {
  type: "platform-response";
  requestId: string;
  method: WebRemoteControlPlatformMethod;
  success: false;
  error: string;
}

export type WebRemoteControlPlatformResponse =
  | WebRemoteControlPlatformSuccessResponse
  | WebRemoteControlPlatformErrorResponse;

export interface WebRemoteControlExternalLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
}

export interface WebRemoteControlExternalRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
}

export type WebRemoteControlExternalWorkspaceBridge =
  | WebRemoteControlExternalLocalWorkspaceBridge
  | WebRemoteControlExternalRemoteWorkspaceBridge;

export interface WebRemoteControlBootstrapRequestPayload {
  zcode_type: "bootstrap-request";
  requestId: string;
}

export interface WebRemoteControlBootstrapResponsePayload {
  zcode_type: "bootstrap-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWorkspaceListRequestPayload {
  zcode_type: "workspace-list-request";
  requestId: string;
}

export interface WebRemoteControlWorkspaceListResponsePayload {
  zcode_type: "workspace-list-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceListUpdatedPayload {
  zcode_type: "workspace-list-updated";
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceBridgeOpenPayload {
  zcode_type: "workspace-bridge-open";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeReadyPayload {
  zcode_type: "workspace-bridge-ready";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  bridge: WebRemoteControlExternalWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorPayload {
  zcode_type: "workspace-bridge-error";
  requestId: string;
  bridgeSessionId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export interface WebRemoteControlWorkspaceReconnectRequestPayload {
  zcode_type: "workspace-reconnect-request";
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlWorkspaceReconnectResponsePayload =
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlMobileViewStatePayload {
  zcode_type: "mobile-view-state-update";
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

export type WebRemoteControlPlatformRequestPayload = {
  [K in WebRemoteControlPlatformMethod]: {
    zcode_type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformResponsePayload =
  | {
      [K in WebRemoteControlPlatformMethod]: {
        zcode_type: "platform-response";
        requestId: string;
        method: K;
        success: true;
        result: WebRemoteControlPlatformMethodResultMap[K];
      };
    }[WebRemoteControlPlatformMethod]
  | {
      zcode_type: "platform-response";
      requestId: string;
      method: WebRemoteControlPlatformMethod;
      success: false;
      error: string;
    };

/** @deprecated 仅供 legacy adapter 单测/迁移使用；production parser 自 04D-3 起拒绝。 */
export interface WebRemoteControlRpcFramePayload {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  dataBase64: string;
}

export interface WebRemoteControlBridgeDegradedPayload {
  zcode_type: "bridge-degraded";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: "rpc-transport-fault" | "rpc-frame-gap" | "buffer-overflow" | "buffer-timeout";
  seq?: number;
  expectedSeq?: number;
  droppedCount?: number;
}

export interface WebRemoteControlAppErrorPayload {
  zcode_type: "app-error";
  requestId?: string;
  bridgeSessionId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export type WebRemoteControlMobileDiagnosticEvent =
  | "state-transition"
  | "socket-close"
  | "socket-error"
  | "recover-start"
  | "recover-scheduled"
  | "pair-status"
  | "failure";

export interface WebRemoteControlMobileDiagnosticPayload {
  zcode_type: "mobile-diagnostic";
  event: WebRemoteControlMobileDiagnosticEvent;
  timestamp: number;
  state?: string;
  previousState?: string;
  pairStatus?: WebRemoteControlRelayPairStatus;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  failureReason?: WebRemoteControlFailureReason;
  failureMessage?: string;
  visibilityState?: string;
  online?: boolean;
  hiddenDurationMs?: number;
}

export type WebRemoteControlAppPayload =
  | { zcode_type: "telemetry-report"; event: MobileSessionCreateTelemetry }
  | WebRemoteControlBootstrapRequestPayload
  | WebRemoteControlBootstrapResponsePayload
  | WebRemoteControlWorkspaceListRequestPayload
  | WebRemoteControlWorkspaceListResponsePayload
  | WebRemoteControlWorkspaceListUpdatedPayload
  | WebRemoteControlWorkspaceBridgeOpenPayload
  | WebRemoteControlWorkspaceBridgeReadyPayload
  | WebRemoteControlWorkspaceBridgeErrorPayload
  | WebRemoteControlWorkspaceReconnectRequestPayload
  | WebRemoteControlWorkspaceReconnectResponsePayload
  | WebRemoteControlMobileViewStatePayload
  | WebRemoteControlPlatformRequestPayload
  | WebRemoteControlPlatformResponsePayload
  | WebRemoteControlRpcTransportPayload
  | WebRemoteControlBridgeDegradedPayload
  | WebRemoteControlAppErrorPayload
  | WebRemoteControlMobileDiagnosticPayload;

export interface WebRemoteControlWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
  kind: "local" | "remote";
  connectionState?: "connected" | "disconnected" | "reconnecting";
  lastConnectionError?: string;
}

export interface WebRemoteControlReconnectWorkspaceRequest {
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlReconnectWorkspaceResult =
  | {
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export type WebRemoteControlTaskDisplayStatus = "idle" | "running" | "completed" | "error";

export interface WebRemoteControlTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: ZCodeProvider;
  unreadAt?: number;
  displayStatus?: WebRemoteControlTaskDisplayStatus;
  // 会话挂着后台工作（动态工作流 run / 后台 bash / 分离子代理）。只参与列表运行层排序，
  // 不影响 displayStatus 图标；缺省视为 false，旧 desktop 快照照常解析。
  hasBackgroundWork?: boolean;
  // 工作流运行摘要（docs/dynamic-workflow/presentation.md「The sidebar run line」）：手机行在标题下
  // 画与桌面一致的运行行。只绘制，不参与排序或状态 pill；无 run 时缺席，旧 desktop 快照照常解析。
  workflowActivity?: SessionWorkflowActivity;
  pinned?: boolean;
  archived?: boolean;
}

export interface WebRemoteControlWorkspaceListResult {
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks?: WebRemoteControlTaskTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export type WebRemoteControlMobileNavigationIntent = "chat";

export interface WebRemoteControlWorkspaceSwitchOptions {
  taskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** 仅由手机任务首页使用；目标 bridge 建立后只清除这次快照对应的未读。 */
  markTaskReadExpectedUnreadAt?: number;
}

export interface WebRemoteControlWorkspaceSwitchResult extends WebRemoteControlSessionCreateResponse {}

export interface WebRemoteControlMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface WebRemoteControlLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  wsUrl: string;
}

export type WebRemoteControlWorkspaceBridge =
  | WebRemoteControlLocalWorkspaceBridge
  | WebRemoteControlRemoteWorkspaceBridge;

export interface WebRemoteControlWindowBootstrapResult {
  windowControlSessionId: string;
  /** 当前连接的桌面实际版本；旧桌面缺失时手机保留原 URL。 */
  desktopAppVersion?: string;
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks: WebRemoteControlTaskTarget[];
  initialViewState?: WebRemoteControlMobileViewState;
  mobileViewState?: WebRemoteControlMobileViewState;
}

export interface WebRemoteControlWindowControlReadyEvent {
  type: "window-control-ready";
  windowControlSessionId: string;
  mobileConnectionId: string;
  expiresAt: number;
}

export function resolveWebRemoteControlWorkspaceKey(
  target: Pick<WebRemoteControlWorkspaceTarget, "workspacePath" | "workspaceIdentity">,
): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function isWebRemoteControlBridgeableWorkspaceTarget(
  workspace: WebRemoteControlWorkspaceTarget,
): boolean {
  return (
    workspace.kind !== "remote" || Boolean(workspace.workspaceIdentity && workspace.remoteSessionId)
  );
}

export function resolveWebRemoteControlInitialWorkspaceSelection({
  workspaces,
  mobileViewState,
  initialViewState,
}: {
  workspaces: WebRemoteControlWorkspaceTarget[];
  mobileViewState?: WebRemoteControlMobileViewState;
  initialViewState?: WebRemoteControlMobileViewState;
}): { workspaceKey: string; taskId?: string; canBridge: boolean } | null {
  const bridgeableWorkspaces = workspaces.filter(isWebRemoteControlBridgeableWorkspaceTarget);
  const workspaceKeys = new Set(
    bridgeableWorkspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const allWorkspaceKeys = new Set(
    workspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const selectedViewState = mobileViewState ?? initialViewState;
  const selectedWorkspaceKey = selectedViewState?.activeWorkspaceKey;

  if (selectedWorkspaceKey && workspaceKeys.has(selectedWorkspaceKey)) {
    return {
      workspaceKey: selectedWorkspaceKey,
      ...(selectedViewState.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
      canBridge: true,
    };
  }

  // Bugfix: 手机端列表会展示已断开的 SSH workspace，但这类项没有 remoteSessionId，
  // 不能作为初始 bridge 目标。否则重连状态尚未同步时会反复进入“尚未连接”的错误页。
  const firstWorkspace = bridgeableWorkspaces[0];
  if (!firstWorkspace) {
    if (selectedWorkspaceKey && allWorkspaceKeys.has(selectedWorkspaceKey)) {
      return {
        workspaceKey: selectedWorkspaceKey,
        ...(selectedViewState?.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
        canBridge: false,
      };
    }

    const firstDisconnectedWorkspace = workspaces[0];
    if (!firstDisconnectedWorkspace) {
      return null;
    }

    return {
      workspaceKey: resolveWebRemoteControlWorkspaceKey(firstDisconnectedWorkspace),
      canBridge: false,
    };
  }

  return {
    workspaceKey: resolveWebRemoteControlWorkspaceKey(firstWorkspace),
    canBridge: true,
  };
}

export interface WebRemoteControlWorkspaceListRequest {
  type: "workspace-list-request";
  requestId: string;
  sessionId: string;
}

export interface WebRemoteControlWorkspaceSwitchRequest {
  type: "workspace-switch-request";
  requestId: string;
  sessionId: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceListSuccessResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceSwitchSuccessResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceSwitchResult;
}

export interface WebRemoteControlWorkspaceListErrorResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlWorkspaceSwitchErrorResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export type WebRemoteControlWorkspaceControlRequest =
  | WebRemoteControlWorkspaceListRequest
  | WebRemoteControlWorkspaceSwitchRequest;

export type WebRemoteControlWorkspaceControlResponse =
  | WebRemoteControlWorkspaceListSuccessResponse
  | WebRemoteControlWorkspaceSwitchSuccessResponse
  | WebRemoteControlWorkspaceListErrorResponse
  | WebRemoteControlWorkspaceSwitchErrorResponse;

export interface WebRemoteControlWindowBootstrapRequest {
  type: "window-bootstrap-request";
  requestId: string;
  windowControlSessionId: string;
}

export interface WebRemoteControlWindowBootstrapSuccessResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWindowBootstrapErrorResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlWorkspaceBridgeRequest {
  type: "workspace-bridge-request";
  requestId: string;
  windowControlSessionId: string;
  bridgeSessionId: string;
  bridgeToken: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeSuccessResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  bridge: WebRemoteControlWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlMobileViewStateUpdate {
  type: "mobile-view-state-update";
  windowControlSessionId: string;
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

export type WebRemoteControlWindowControlRequest =
  | WebRemoteControlWindowBootstrapRequest
  | WebRemoteControlWorkspaceBridgeRequest
  | WebRemoteControlMobileViewStateUpdate;

export type WebRemoteControlWindowControlResponse =
  | WebRemoteControlWindowBootstrapSuccessResponse
  | WebRemoteControlWindowBootstrapErrorResponse
  | WebRemoteControlWorkspaceBridgeSuccessResponse
  | WebRemoteControlWorkspaceBridgeErrorResponse;

export type RelayDesktopControlEvent =
  | { type: "tunnel-registered"; tunnelId: string }
  | { type: "window-control-registered"; tunnelId: string }
  | { type: "web-remote-control-session-request"; sessionId: string }
  | { type: "mobile-connected"; windowControlSessionId: string }
  | { type: "mobile-disconnected"; windowControlSessionId: string }
  | WebRemoteControlPlatformRequest
  | WebRemoteControlPlatformResponse
  | WebRemoteControlWorkspaceControlRequest
  | WebRemoteControlWorkspaceControlResponse
  | WebRemoteControlWindowControlRequest
  | WebRemoteControlWindowControlResponse;
