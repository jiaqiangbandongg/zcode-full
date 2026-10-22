import { BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";
import {
  buildWebRemoteControlStartResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  PlatformChannels,
  webRemoteControlAuthStateChangeSchema,
  type WebRemoteControlAuthStateChange,
  type TelemetryEventPayload,
  type WebRemoteControlContext,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
} from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "./webRemoteControlManager.js";

export interface WebRemoteControlIpcManager {
  authorizeStart: (
    windowId: number,
    context: WebRemoteControlContext,
  ) => WebRemoteControlStartAuthorization;
  startAuthorized: (
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ) => Promise<WebRemoteControlStartResult>;
  notifyAuthStateChanged(windowId: number, change: WebRemoteControlAuthStateChange): Promise<void>;
  stop(windowId: number): Promise<void>;
  getStatus(windowId: number): WebRemoteControlStatus;
}

interface WebRemoteControlIpcDependencies {
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  webRemoteControlManager: WebRemoteControlIpcManager;
}

function reportRemoteUsageEventSafely(
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"],
  rendererId: number,
  event: TelemetryEventPayload,
): void {
  try {
    reportRemoteUsageEvent(rendererId, event);
  } catch {
    // Bug 根因：埋点回调原来位于业务 operation 的 try 内，回调抛错会把已成功的启动误判为失败，
    // 甚至覆盖真正的业务错误。埋点是旁路能力，这里必须吞掉异常并保留 operation 的原始终态。
  }
}

function resolveWorkspaceKind(context: WebRemoteControlContext): "local" | "remote" {
  return context.workspaceIdentity?.trim() || context.remoteSessionId?.trim() ? "remote" : "local";
}

async function runStartOperation(input: {
  context: WebRemoteControlContext;
  sender: WebContents;
  missingWindowMessage: string;
  operation: (windowId: number) => Promise<WebRemoteControlStartResult>;
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"];
}): Promise<WebRemoteControlStartResult> {
  const workspaceKind = resolveWorkspaceKind(input.context);
  const remoteKind = input.context.workspaceIdentity
    ? parseRemoteWorkspaceIdentity(input.context.workspaceIdentity)?.kind
    : undefined;
  const rendererId = input.sender.id;
  try {
    const win = BrowserWindow.fromWebContents(input.sender);
    if (!win) {
      throw new Error(input.missingWindowMessage);
    }
    // 交互边界：远控面板已有显式用户操作，main 只校验窗口并绑定目标，
    // 不再叠加原生确认弹窗，避免一次操作出现两层确认。
    const response = await input.operation(win.id);
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        result: "success",
        workspaceKind,
        remoteKind,
      }),
    );
    return response;
  } catch (error) {
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        result: "failure",
        workspaceKind,
        remoteKind,
        errorCategory: classifyRemoteUsageError(error),
      }),
    );
    throw error;
  }
}

export function registerWebRemoteControlIpcHandlers(
  dependencies: WebRemoteControlIpcDependencies,
): void {
  ipcMain.on(PlatformChannels.WebRemoteControlAuthStateChanged, (event, payload: unknown) => {
    const parsed = webRemoteControlAuthStateChangeSchema.safeParse(payload);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!parsed.success || !win) return;
    // 单向通知不把异步异常泄漏到 Electron；下次通知或 workspace sync 可重试恢复。
    void dependencies.webRemoteControlManager
      .notifyAuthStateChanged(win.id, parsed.data)
      .catch(() => {});
  });
  ipcMain.handle(
    PlatformChannels.StartWebRemoteControl,
    async (event, context: WebRemoteControlContext) =>
      runStartOperation({
        context,
        sender: event.sender,
        missingWindowMessage: "未找到当前窗口，无法开启 Web 远程控制",
        operation: (windowId) => {
          const manager = dependencies.webRemoteControlManager;
          const authorization = manager.authorizeStart(windowId, context);
          return manager.startAuthorized(windowId, context, authorization);
        },
        reportRemoteUsageEvent: dependencies.reportRemoteUsageEvent,
      }),
  );

  ipcMain.handle(PlatformChannels.StopWebRemoteControl, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await dependencies.webRemoteControlManager.stop(win.id);
    }
  });

  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win
      ? dependencies.webRemoteControlManager.getStatus(win.id)
      : { status: "idle" as const };
  });
}
