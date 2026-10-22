import type { WebRemoteControlStatus, WebRemoteControlFailure } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function isSameWebRemoteControlTarget(
  status: WebRemoteControlStatus,
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: 之前这里仅凭 sessionId 存在就判定“同一目标”，会把其他 workspace 的旧会话误复用，
  // 导致当前 workspace 打开弹层时不触发 start，状态长期卡在 starting。
  // 这里改为严格比较 workspaceKey(identity 优先) + remoteSessionId，确保会话和目标一一对应。
  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }

  const expectedWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const statusWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: statusWorkspacePath,
    workspaceIdentity: status.workspaceIdentity,
  });
  if (statusWorkspaceKey !== expectedWorkspaceKey) {
    return false;
  }

  const expectedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const statusRemoteSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusRemoteSessionId !== expectedRemoteSessionId) {
    return false;
  }

  return Boolean(status.windowControlSessionId ?? status.sessionId);
}

export function isReusableWebRemoteControlSession(status: WebRemoteControlStatus): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: 打开桌面弹层只是查看/管理 window 级远控入口，不能因为当前桌面 workspace
  // 和手机已 bridge 的 workspace 不一致就重启 device relay 会话；否则会主动给手机发
  // desktop-disconnected。只有已经连上手机的会话才跨 workspace 复用，避免未连接的旧二维码
  // 继续把新扫码用户带回旧默认 workspace。
  return Boolean(status.mobileConnected && (status.windowControlSessionId ?? status.sessionId));
}

export function getStatusLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.status.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.status.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.status.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.status.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.status.idle" });
  }
}

export function getStatusDetail(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.statusDetail.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.statusDetail.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.statusDetail.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.statusDetail.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.statusDetail.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusDetail.idle" });
  }
}

export function getStatusDotClassName(status: WebRemoteControlStatus): string {
  if (status.status === "error") {
    return "bg-destructive";
  }
  if (status.status === "active") {
    return "bg-success";
  }
  if (status.status === "idle") {
    return "bg-border";
  }
  return "bg-warning";
}

export function getWebRemoteControlStatusTagLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  const deviceName =
    status.mobileDeviceInfo?.browserPlatform?.trim() || status.mobileDeviceInfo?.name?.trim();

  if (deviceName) {
    return deviceName;
  }

  if (status.mobileConnected) {
    return formatMessage({ id: "webRemoteControl.statusTag.phone" });
  }

  if (status.status === "idle") {
    return formatMessage({ id: "webRemoteControl.status.idle" });
  }

  if (status.status === "error") {
    return formatMessage({ id: "webRemoteControl.status.error" });
  }

  return formatMessage({ id: "webRemoteControl.statusTag.ready" });
}

export function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.deviceToken === right.deviceToken &&
    left.expiresAt === right.expiresAt &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.qrUrl === right.qrUrl &&
    left.connectUrl === right.connectUrl &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.remoteSessionId === right.remoteSessionId &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

export function getFailureDescription(
  failure: WebRemoteControlFailure | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string | null {
  if (!failure) {
    return null;
  }

  switch (failure.reason) {
    case "session-not-found":
      return formatMessage({ id: "webRemoteControl.failure.sessionNotFound" });
    case "session-expired":
      return formatMessage({ id: "webRemoteControl.failure.sessionExpired" });
    case "session-conflict":
      if (failure.message?.toLowerCase().includes("kicked")) {
        return formatMessage({ id: "webRemoteControl.failure.kicked" });
      }
      return formatMessage({ id: "webRemoteControl.failure.sessionConflict" });
    case "workspace-closed":
      return formatMessage({ id: "webRemoteControl.failure.workspaceClosed" });
    case "desktop-disconnected":
      return formatMessage({
        id: "webRemoteControl.failure.desktopDisconnected",
      });
    case "invalid-mobile-connection":
      return formatMessage({
        id: "webRemoteControl.failure.invalidMobileConnection",
      });
    case "desktop-bootstrap-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.desktopBootstrapTimeout",
      });
    case "connection-recovery-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.connectionRecoveryTimeout",
      });
    case "relay-unavailable":
      return formatMessage({ id: "webRemoteControl.failure.relayUnavailable" });
    case "unsupported-action":
      return formatMessage({
        id: "webRemoteControl.failure.unsupportedAction",
      });
    case "device-not-owned":
    case "auth-required":
      return failure.message ?? null;
    case "unexpected-error":
      return formatMessage({ id: "webRemoteControl.failure.unexpectedError" });
  }
}
