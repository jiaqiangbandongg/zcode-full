import type { BrowserWindow } from "electron";
import {
  type ExternalWorkspaceOpenDialogCopy,
  confirmExternalWorkspaceOpen,
  isNetworkWorkspacePath,
  isValidLocalWorkspaceDirectory,
} from "./desktopOAuthDeepLink.js";
import {
  createOpenWorkspaceStartupBootstrap,
  type StartupWindowBootstrap,
} from "./startupWorkspace.js";

export type ExplicitStartupWorkspaceSource = "open-workspace-arg" | "deep-link";

export interface ExplicitStartupWorkspaceRequest {
  path: string;
  source: ExplicitStartupWorkspaceSource;
}

export interface StartupDeepLinkConsumptionGate {
  markStartupRequestConsumed: (request: ExplicitStartupWorkspaceRequest) => void;
  shouldHandleReadyProtocolUrl: (protocolUrl: string | null) => boolean;
}

interface ResolveExplicitStartupWorkspaceBootstrapDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  parentWindow?: BrowserWindow | null;
}

export function createStartupDeepLinkConsumptionGate(
  startupProtocolUrl: string | null,
): StartupDeepLinkConsumptionGate {
  let startupDeepLinkConsumed = false;

  return {
    markStartupRequestConsumed: (request) => {
      if (request.source !== "deep-link") {
        return;
      }

      // 冷启动 argv deep link 在 startup bootstrap 中无论确认、取消或校验失败，
      // 都必须形成一次性消费，避免 app.whenReady 再从 process.argv 重放同一个外部 URL。
      startupDeepLinkConsumed = true;
    },
    shouldHandleReadyProtocolUrl: (protocolUrl) => {
      if (!protocolUrl) {
        return false;
      }

      return !(startupDeepLinkConsumed && protocolUrl === startupProtocolUrl);
    },
  };
}

export function resolveExplicitStartupWorkspaceBootstrap(
  request: ExplicitStartupWorkspaceRequest,
  deps: ResolveExplicitStartupWorkspaceBootstrapDeps,
): StartupWindowBootstrap | null {
  if (request.source === "deep-link") {
    if (isNetworkWorkspacePath(request.path)) {
      // 冷启动 deep link 不能绕过运行中 deep link 的 UNC 早拒绝；
      // 网络路径必须在任何 statSync 等 filesystem probe 前停止。
      deps.logger.warn("[deep-link] 网络工作区路径已拒绝", { path: request.path });
      return null;
    }

    // 首窗 bootstrap 发生在 renderer ready 前，不能走后续 IPC gate；
    // deep link 来源仍必须先让用户确认，取消后回退默认启动。
    if (
      !confirmExternalWorkspaceOpen(
        request.path,
        deps.logger,
        deps.parentWindow ?? null,
        deps.confirmationCopy,
      )
    ) {
      return null;
    }
  }

  if (!isValidLocalWorkspaceDirectory(request.path)) {
    deps.logger.warn("[startup-workspace] open-workspace argv invalid, falling back", {
      path: request.path,
    });
    return null;
  }

  deps.logger.info("[startup-workspace] using explicit open workspace:", request.path);
  return createOpenWorkspaceStartupBootstrap(request.path);
}
