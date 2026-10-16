import { sessionCreateTelemetrySchema, type RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制启动、错误页和 web 平台桥接暂时集中在入口编排。 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type Theme,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import {
  connectViaProtocol,
  connectViaWebSocket,
  createAcknowledgedWebRemoteControlRelayProtocol,
  type WebSocketConnectionCloseEvent,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  resolveWebRemoteControlRelayWsUrl,
} from "@zcode/shared";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { WebLoggedInWaitingPage } from "./auth/WebLoggedInWaitingPage.js";
import { WebLoginPage } from "./auth/WebLoginPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import type {
  IPlatformService,
  WebRemoteControlBootstrapErrorResponse,
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWindowControlReadyEvent,
  WebRemoteControlWorkspaceBridge,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceSwitchOptions,
  WebRemoteControlStatus,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  RemoteTarget,
  ServerRemoteInfo,
  UserInfo,
} from "@zcode/shared";
import {
  matchesWebRemoteControlRoutePath,
  parseWebRemoteControlExternalQrParams,
  resolveWebRemoteControlFailureReasonFromCloseCode,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
import { createBrowserWebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import {
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
} from "./webRemoteControlTransport.js";
import { createWebRemoteControlLifecycleRecovery } from "./webRemoteControlLifecycle.js";
import {
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
  resolveWebRemoteControlInitialTheme,
  seedWebRemoteControlThemePreference,
} from "./webRemoteControlThemeSeed.js";
import {
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
} from "./webRemoteControlFailureScreen.js";
import { collectWebRemoteControlMobileDeviceInfo } from "./webRemoteControlDeviceInfo.js";
import { createWebRemoteControlVersionGuard } from "./webRemoteControlVersion.js";
import { showWebRemoteControlVersionNotice } from "./webRemoteControlVersionNotice.js";
import { resolveWebRemoteControlRoutePath } from "./webRemoteControlRoute.js";
import {
  registerWebRemoteControlWorkspaceBridgeServices,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
} from "./webRemoteControlWorkspaceBridgeSession.js";
import {
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "./webRemoteControlTaskRead.js";
type RootServices = Parameters<typeof Root>[0]["services"];
type ServiceMethod = (...args: any[]) => unknown;

function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // 修复原因：同路径 remote workspace 可能属于不同 identity，禁止误用当前 bridge 写另一条连接。
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

function resolveWebThemePreference(defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

// 浏览器标签页 / 手机切后台时禁用 CSS 动画，避免 DocumentTimeline 持有已卸载的 DOM 子树。
installDocumentHiddenMotionPause();
const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();
let isPageUnloading = false;
let isSwitchingWebRemoteControlWorkspace = false;

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

window.addEventListener("beforeunload", () => {
  isPageUnloading = true;
});

interface WebRemoteControlProxyOptions {
  token: string;
  relayOrigin: string;
  windowControlSessionId: string;
  mobileConnectionId: string;
}

interface WebRemoteControlPlatformProxy {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]>;
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      onReload={() => {
        window.location.reload();
      }}
    />,
  );
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/web-remote/callback", "/cn/share/callback", "/share/callback"].includes(
      window.location.pathname,
    ) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function isWebRemoteRoute(): boolean {
  return window.location.pathname === "/web-remote" || window.location.pathname === "/web-remote/";
}

function shouldUseWebRemoteAuth(params: URLSearchParams): boolean {
  void params;
  return isWebRemoteRoute();
}

function resolveWebRemoteAppReturnTo(params: URLSearchParams): string {
  if (isWebRemoteRoute() || !params.has("remoteControlToken")) {
    return window.location.href;
  }

  const appReturnTo = new URL(window.location.href);
  appReturnTo.pathname = "/web-remote";
  return appReturnTo.toString();
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/web-remote");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/web-remote");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG, "share"),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

function renderWebLoginPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(
    <WebLoginPage
      onLogin={() => {
        const params = new URLSearchParams(window.location.search);
        webAuthService.startLogin({
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
          appReturnTo: resolveWebRemoteAppReturnTo(params),
        });
      }}
    />,
  );
}

function renderWebLoggedInWaitingPage(user: UserInfo): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebLoggedInWaitingPage
      user={user}
      onLogout={async () => {
        await webAuthService.logout();
        window.location.replace("/web-remote");
      }}
    />,
  );
}

function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function parseWebRemoteControlBootstrapError(payload: unknown): WebRemoteControlFailure | null {
  if (typeof payload !== "object" || payload == null) {
    return null;
  }

  const record = payload as Partial<WebRemoteControlBootstrapErrorResponse>;
  if (typeof record.reason !== "string") {
    return null;
  }

  return toWebRemoteControlFailure(
    record.reason as WebRemoteControlFailureReason,
    typeof record.error === "string" ? record.error : undefined,
  );
}

function mapWebRemoteControlSocketCloseToFailure(event: {
  code: number;
  reason: string;
}): WebRemoteControlFailure {
  const resolvedReason =
    resolveWebRemoteControlFailureReasonFromCloseCode(event.code) ??
    (event.reason as WebRemoteControlFailureReason | "");

  switch (resolvedReason) {
    case "session-not-found":
    case "session-expired":
    case "session-conflict":
    case "workspace-closed":
    case "desktop-disconnected":
    case "invalid-mobile-connection":
    case "desktop-bootstrap-timeout":
    case "connection-recovery-timeout":
      return toWebRemoteControlFailure(resolvedReason, event.reason || undefined);
    default:
      return toWebRemoteControlFailure(
        "relay-unavailable",
        event.reason || "Web remote control connection closed unexpectedly.",
      );
  }
}

async function requestWebRemoteControlPlatformMethod<K extends WebRemoteControlPlatformMethod>(
  proxy: WebRemoteControlProxyOptions,
  method: K,
  args?: WebRemoteControlPlatformMethodArgsMap[K],
): Promise<WebRemoteControlPlatformMethodResultMap[K]> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/platform/${proxy.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
    },
  );
  const payload = (await response.json()) as
    | { result: WebRemoteControlPlatformMethodResultMap[K] }
    | { error?: string };

  if (!response.ok) {
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(
      errorMessage || `Failed to invoke Web remote control platform method: ${method}`,
    );
  }

  if (!("result" in payload)) {
    throw new Error(`Missing Web remote control platform result: ${method}`);
  }

  return payload.result;
}

async function requestWebRemoteControlWorkspaces(
  proxy: WebRemoteControlProxyOptions,
): Promise<WebRemoteControlWorkspaceListResult> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/bootstrap/${proxy.token}`,
  );
  const payload = (await response.json()) as
    | WebRemoteControlWindowBootstrapResult
    | { error?: string };

  if (!response.ok) {
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to list Web remote control workspaces");
  }

  if (!("workspaces" in payload)) {
    throw new Error("Missing Web remote control workspace list");
  }

  return {
    workspaces: payload.workspaces,
    tasks: payload.tasks,
    activeWorkspaceKey:
      payload.mobileViewState?.activeWorkspaceKey ?? payload.initialViewState?.activeWorkspaceKey,
    activeTaskId: payload.mobileViewState?.activeTaskId ?? payload.initialViewState?.activeTaskId,
  };
}

async function requestWebRemoteControlWorkspaceBridge(
  proxy: WebRemoteControlProxyOptions,
  workspaceKey: string,
  options?: WebRemoteControlWorkspaceSwitchOptions,
): Promise<WebRemoteControlWorkspaceBridge> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/${proxy.token}/workspace-bridge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-Mobile-Connection-Id": proxy.mobileConnectionId,
      },
      body: JSON.stringify({
        workspaceKey,
        ...(options?.taskId ? { taskId: options.taskId } : {}),
      }),
    },
  );
  const payload = (await response.json()) as
    | WebRemoteControlWorkspaceBridge
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string };

  if (!response.ok) {
    const parsedFailure = parseWebRemoteControlBootstrapError(payload);
    if (parsedFailure) {
      throw parsedFailure;
    }
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to switch Web remote control workspace");
  }
  if (!("wsUrl" in payload)) {
    throw new Error("Missing Web remote control bridge wsUrl");
  }

  return payload;
}

async function updateWebRemoteControlMobileViewState(
  proxy: WebRemoteControlProxyOptions,
  workspaceKey: string,
  taskId?: string,
): Promise<void> {
  const deviceInfo = collectWebRemoteControlMobileDeviceInfo();
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/${proxy.token}/mobile-view-state`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-Mobile-Connection-Id": proxy.mobileConnectionId,
      },
      body: JSON.stringify({
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
        deviceInfo,
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string }
    | null;

  if (!response.ok) {
    const parsedFailure = parseWebRemoteControlBootstrapError(payload);
    if (parsedFailure) {
      throw parsedFailure;
    }
    const errorMessage = payload && "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to update Web remote control mobile view state");
  }
}

function createWebPlatform(options?: {
  webRemoteControlProxy?: WebRemoteControlProxyOptions;
  externalWebRemoteControlProxy?: WebRemoteControlPlatformProxy;
}): IPlatformService {
  const webRemoteControlProxy = options?.webRemoteControlProxy;
  const platformProxy = options?.externalWebRemoteControlProxy;

  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("createTempTextAttachment", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "createTempTextAttachment",
              payload,
            )
          : Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // Bugfix: Web 远程控制模式虽然复用了 web UI，但它背后其实挂着 desktop。
    // 之前这里仍然走普通 web 的 `/api/connect-remote`，既不能命中 desktop main，
    // 也拿不到 remote session 的 MessagePort，结果看起来像“支持”，实际必然失败。
    // 先显式拒绝，避免用户沿着错误链路继续排查；后续如果要支持，需要单独补 remote session 注入协议。
    async connectRemote(
      options: RemoteTarget,
      _requestId?: string,
      _context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      },
    ) {
      if (webRemoteControlProxy || platformProxy) {
        return {
          success: false,
          error: `Remote connect is not supported in Web remote control mode yet: ${options.kind}`,
        };
      }

      // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
      // 之前这里虽然能打开 ?remote=<id> 新标签页，但远程 WebSocket 只暴露部分 service，
      // 与 Root/RemoteServiceAccess 需要的完整 accessor 不匹配，最终会在项目向导或首屏卡住。
      return {
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      };
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // Web 端不作为 Web 远程控制的发起端，保留空实现以兼容统一接口。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    refreshWebRemoteControlPairing: () =>
      Promise.reject(new Error("Web remote control pairing can only be refreshed from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () =>
      Promise.resolve<WebRemoteControlStatus>({
        status: "idle",
      }),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("isDockerAvailable")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "isDockerAvailable")
          : Promise.resolve(false),
    listWSLDistros: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listWSLDistros")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listWSLDistros")
          : Promise.resolve([]),
    listDockerContainers: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listDockerContainers")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listDockerContainers")
          : Promise.resolve([]),
    listSSHConfigAliases: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listSSHConfigAliases")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listSSHConfigAliases")
          : Promise.resolve([]),
    loadMcpFromUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("loadMcpFromUserDirectory", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "loadMcpFromUserDirectory",
              payload,
            )
          : Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("saveMcpToUserDirectory", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "saveMcpToUserDirectory",
              payload,
            )
          : Promise.resolve({
              success: false,
              error: "MCP native directory management requires a desktop attachment",
            }),
    migrateLegacyCommonMcp: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("migrateLegacyCommonMcp", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "migrateLegacyCommonMcp",
              payload,
            )
          : Promise.resolve({
              servers: {},
              totalCount: 0,
              importedCount: 0,
              skippedCount: 0,
            }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async (event) => {
      // 手机只开放 session_create；不能把原有 Desktop conversation 事件一并启用。
      const parsed = sessionCreateTelemetrySchema.safeParse(event);
      if (parsed.success) platformProxy?.reportTelemetryEvent?.(parsed.data);
    },
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

async function requestWebRemoteControlWindowBootstrap(
  proxy: Pick<WebRemoteControlProxyOptions, "token" | "relayOrigin">,
): Promise<WebRemoteControlWindowBootstrapResult> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/bootstrap/${proxy.token}`,
  );
  const payload = (await response.json()) as
    | WebRemoteControlWindowBootstrapResult
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string };

  if (!response.ok) {
    throw (
      parseWebRemoteControlBootstrapError(payload) ??
      toWebRemoteControlFailure(
        "unexpected-error",
        "error" in payload ? payload.error : "Failed to bootstrap Web remote control",
      )
    );
  }
  if (!("workspaces" in payload)) {
    throw toWebRemoteControlFailure(
      "unexpected-error",
      "Missing Web remote control bootstrap workspaces",
    );
  }

  return payload;
}

function parseWindowControlReadyEvent(
  raw: MessageEvent,
): WebRemoteControlWindowControlReadyEvent | null {
  if (typeof raw.data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw.data) as WebRemoteControlWindowControlReadyEvent;
    if (
      parsed?.type === "window-control-ready" &&
      typeof parsed.windowControlSessionId === "string" &&
      typeof parsed.mobileConnectionId === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function connectWebRemoteControlWindow(
  proxy: Pick<WebRemoteControlProxyOptions, "token" | "relayOrigin">,
  onClose: (event: WebSocketConnectionCloseEvent) => void,
): Promise<{
  socket: WebSocket;
  ready: WebRemoteControlWindowControlReadyEvent;
}> {
  return await new Promise((resolve, reject) => {
    const wsOrigin = proxy.relayOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const socket = new WebSocket(
      `${wsOrigin.replace(/\/$/, "")}/ws/remote-control/window/${proxy.token}`,
    );
    let settled = false;

    const cleanup = () => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleCloseBeforeReady);
    };

    const handleMessage = (event: MessageEvent) => {
      const ready = parseWindowControlReadyEvent(event);
      if (!ready) {
        return;
      }

      settled = true;
      cleanup();
      socket.addEventListener("close", (closeEvent) => {
        onClose({
          code: closeEvent.code,
          reason: closeEvent.reason,
          wasClean: closeEvent.wasClean,
        });
      });
      resolve({ socket, ready });
    };

    const handleError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Web remote control window socket failed"));
      }
    };

    const handleCloseBeforeReady = (event: CloseEvent) => {
      cleanup();
      if (!settled) {
        reject(
          toWebRemoteControlFailure(
            resolveWebRemoteControlFailureReasonFromCloseCode(event.code) ?? "relay-unavailable",
            event.reason || "Web remote control window socket closed before ready",
          ),
        );
      }
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleCloseBeforeReady);
  });
}

function selectInitialWebRemoteControlWorkspace(
  snapshot: WebRemoteControlWindowBootstrapResult,
): ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection> {
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

function isWebRemoteControlRoute(): boolean {
  return matchesWebRemoteControlRoutePath(
    window.location.pathname,
    resolveWebRemoteControlRoutePath(import.meta.env),
  );
}

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

function createUnsupportedHomeOnlyService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new Error(
          `${serviceName}.${String(property)} is not available before a Web remote control workspace bridge is connected.`,
        );
      },
    },
  ) as T;
}

function createEmptyHomeOnlyService<T extends object>(handlers: Record<string, ServiceMethod>): T {
  return new Proxy(handlers, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }
      return target[property] ?? (async () => undefined);
    },
  }) as T;
}

export function createHomeOnlyWebRemoteControlServices(): RootServices {
  const unsupported = (channel: string) => async () => {
    throw new Error(
      `${channel} is not available before a Web remote control workspace bridge is connected.`,
    );
  };
  const settingService: RootServices["settingService"] = {
    get: async () => ({
      recentProjects: [],
      locale: resolveWebRemoteControlScreenLocale(navigator.language),
    }),
    update: async () => {},
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async (path: string) => ({ path, created: false }),
  };

  const emptyGitSummary = (workspacePath: string) => ({
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  });
  // Bugfix: 手机端只有断开的远程 workspace 时，不能为了进入任务首页强行创建 bridge。
  // 这里提供只读/空结果服务，吸收 Root 首屏 OAuth、模型供应商、Git、技能等后台初始化，
  // 避免断连这种预期状态被误报成未处理异常；真正聊天能力仍需重连成功后切到 bridge services。
  const homeOnlyZCodeTaskService = createEmptyHomeOnlyService<RootServices["zcodeTaskService"]>({
    initialize: async () => ({ available: false }),
    releaseWorkspacePreparation: async () => {},
    checkCodexConnectivity: async () => ({ ok: true }),
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskTokenUsage: async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    listArchivedTasks: async () => [],
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
    getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async () => null,
  });
  return {
    fileService: {
      readdir: unsupported("fileService.readdir"),
      stat: unsupported("fileService.stat"),
      checkFilesExist: unsupported("fileService.checkFilesExist"),
      resolvePath: unsupported("fileService.resolvePath"),
      createDefaultWorkspace: unsupported("fileService.createDefaultWorkspace"),
      ensureConversationWorkspace: unsupported("fileService.ensureConversationWorkspace"),
      createScratchWorkspace: unsupported("fileService.createScratchWorkspace"),
      readTextFile: unsupported("fileService.readTextFile"),
      readMediaPreview: unsupported("fileService.readMediaPreview"),
      readFileRange: unsupported("fileService.readFileRange"),
      readBinaryPreview: unsupported("fileService.readBinaryPreview"),
      searchWorkspaceFiles: unsupported("fileService.searchWorkspaceFiles"),
      listWorkspaceFilesLength: unsupported("fileService.listWorkspaceFilesLength"),
      listWorkspaceFilesRange: unsupported("fileService.listWorkspaceFilesRange"),
      readWorkspaceFileSearchIgnore: unsupported("fileService.readWorkspaceFileSearchIgnore"),
      applyWorkspaceFileSearchIgnoreTransform: unsupported(
        "fileService.applyWorkspaceFileSearchIgnoreTransform",
      ),
      writeWorkspaceFileSearchIgnore: unsupported("fileService.writeWorkspaceFileSearchIgnore"),
    },
    mediaPreviewService:
      createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>(
        "mediaPreviewService",
      ),
    gitService: createEmptyHomeOnlyService<RootServices["gitService"]>({
      getRepositorySummary: async (params: { workspacePath: string }) =>
        emptyGitSummary(params.workspacePath),
      getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
      getLocalBranches: async () => ({ branches: [], currentBranch: null }),
      getChanges: async () => [],
      getIgnoredPaths: async () => [],
      getDiff: async () => ({ sections: [], files: [] }),
      getBranchComparison: async () => ({
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      }),
      getIdentity: async () => ({
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      }),
      refresh: async () => ({ ok: true }),
    }),
    gitCheckpointService:
      createUnsupportedHomeOnlyService<RootServices["gitCheckpointService"]>(
        "gitCheckpointService",
      ),
    systemService: createUnsupportedHomeOnlyService<RootServices["systemService"]>("systemService"),
    terminalService:
      createUnsupportedHomeOnlyService<RootServices["terminalService"]>("terminalService"),
    settingService,
    credentialService: createEmptyHomeOnlyService<RootServices["credentialService"]>({
      load: async () => null,
    }),
    broadcastService: createEmptyHomeOnlyService<RootServices["broadcastService"]>({
      send: async () => {},
      onMessage: () => ({ dispose: () => {} }),
    }),
    zcodeTaskService: homeOnlyZCodeTaskService,
    zcodeAgentService: createEmptyHomeOnlyService<RootServices["zcodeAgentService"]>({
      initialize: async (params: { workspacePath: string; workspaceIdentity?: string }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode agent service is not available before workspace bridge is connected.",
      }),
      disposeAll: () => {},
    }),
    zcodeSessionService: createEmptyHomeOnlyService<RootServices["zcodeSessionService"]>({
      initializeWorkspace: async (params: {
        workspacePath: string;
        workspaceIdentity?: string;
      }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode session service is not available before workspace bridge is connected.",
      }),
    }),
    // 分享发布首期只属于 desktop local host；Web 首页和 /remote 不建立独立发布权威。
    conversationShareService: createUnsupportedHomeOnlyService<
      RootServices["conversationShareService"]
    >("conversationShareService"),
    promptAttachmentTransferService: createEmptyHomeOnlyService<
      RootServices["promptAttachmentTransferService"]
    >({
      stage: unsupported("promptAttachmentTransferService.stage"),
      adopt: async () => {},
      cancel: async () => {},
      cleanup: async () => {},
      onDynamicProgress: () => () => ({ dispose: () => {} }),
    }),
    botsService: createUnsupportedHomeOnlyService<RootServices["botsService"]>("botsService"),
    fileWatcherService: createEmptyHomeOnlyService<RootServices["fileWatcherService"]>({
      watch: async () => ({ dispose: () => {} }),
    }),
    oauthService: createEmptyHomeOnlyService<RootServices["oauthService"]>({
      getProviders: async () => [],
      getActiveProvider: async () => null,
      restoreCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      restoreSession: async () => null,
      refreshToken: async () => {},
      logout: async () => {},
      logoutAll: async () => {},
      cancelPending: async () => {},
    }),
    providerSettingsService: createEmptyHomeOnlyService<RootServices["providerSettingsService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      refresh: async () => ({ revision: 0, providers: [] }),
      testModelConnectivity: async () => ({ results: [] }),
      onDidChange: () => ({ dispose() {} }),
    }),
    modelSelectionService: createEmptyHomeOnlyService<RootServices["modelSelectionService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      onDidChange: () => ({ dispose() {} }),
    }),
    usageStatsService:
      createUnsupportedHomeOnlyService<RootServices["usageStatsService"]>("usageStatsService"),
    codingPlanSubscriptionService: createUnsupportedHomeOnlyService<
      RootServices["codingPlanSubscriptionService"]
    >("codingPlanSubscriptionService"),
    clientConfigService: createEmptyHomeOnlyService<RootServices["clientConfigService"]>({
      getSnapshot: async () => ({ pluginStoreOrder: null, zsrcUrl: null }),
    }),
    // 手机 Web 未连接 shared-host attachment 时禁止直连 scenes HTTP；返回空配置保持首页可用。
    clientScenesService: createEmptyHomeOnlyService<RootServices["clientScenesService"]>({
      list: async () => ({ code: 0, msg: "", data: [] }),
    }),
    // 闲时任务仅桌面本地（D13）；web home-only 环境按不支持处理。
    offPeakTaskService:
      createUnsupportedHomeOnlyService<RootServices["offPeakTaskService"]>("offPeakTaskService"),
    highspeedCardService:
      createUnsupportedHomeOnlyService<RootServices["highspeedCardService"]>(
        "highspeedCardService",
      ),
    skillsService: createEmptyHomeOnlyService<RootServices["skillsService"]>({
      list: async () => ({
        skills: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
        diagnostics: [],
      }),
      buildPromptContext: async ({ prompt }: { prompt: string }) => ({
        prompt,
        activatedSkillNames: [],
      }),
    }),
    skillSyncService:
      createUnsupportedHomeOnlyService<RootServices["skillSyncService"]>("skillSyncService"),
    mcpSyncService:
      createUnsupportedHomeOnlyService<RootServices["mcpSyncService"]>("mcpSyncService"),
    pluginSyncService:
      createUnsupportedHomeOnlyService<RootServices["pluginSyncService"]>("pluginSyncService"),
    pluginsService: createEmptyHomeOnlyService<RootServices["pluginsService"]>({
      list: async () => [],
    }),
    // M5 ③-3：设置页插件管理仅桌面/远控 bridge 可用，Web 首页 fallback 明确报不可用。
    pluginManagementService:
      createUnsupportedHomeOnlyService<RootServices["pluginManagementService"]>(
        "pluginManagementService",
      ),
    subagentsService: createEmptyHomeOnlyService<RootServices["subagentsService"]>({
      list: async () => ({ agents: [], capability: { supported: false } }),
    }),
    commandsService: createEmptyHomeOnlyService<RootServices["commandsService"]>({
      list: async () => ({
        commands: [],
        userCommands: [],
        pluginCommands: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      }),
      setCommandEnabled: async () => undefined,
    }),
    hooksService: createEmptyHomeOnlyService<RootServices["hooksService"]>({
      loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
      saveHooks: async () => undefined,
    }),
    memoryService: createEmptyHomeOnlyService<RootServices["memoryService"]>({
      loadMemory: async () => ({ memory: null }),
      listProjectMemories: async () => [],
    }),
    outputStyleService: createEmptyHomeOnlyService<RootServices["outputStyleService"]>({
      listStyles: async () => ({ styles: [] }),
      getUserStylesDirectory: async () => ({ path: "" }),
    }),
    // Bugfix: feedbackService 成为统一服务接口后，Web 远控首页 fallback 也必须补齐。
    // 断开 bridge 时这里明确报不可用，避免类型通过但运行时误以为空反馈数据。
    feedbackService:
      createUnsupportedHomeOnlyService<RootServices["feedbackService"]>("feedbackService"),
    settingsSyncService:
      createUnsupportedHomeOnlyService<RootServices["settingsSyncService"]>("settingsSyncService"),
  };
}

function resolveExternalRelayWsUrl(): string {
  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim() ||
    import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim();
  return resolveWebRemoteControlRelayWsUrl({
    endpointOrigin,
    overrideUrl: import.meta.env.VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL,
  });
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function resolveWebRemoteControlLoadingCopy(state: WebRemoteControlTerminalTransportState): {
  title: string;
  description: string;
  steps: string[];
} {
  const zh = isZhLocale();
  const steps = zh
    ? ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"]
    : [
        "Connect to relay service",
        "Authenticate device",
        "Wait for desktop pairing",
        "Sync workspace",
      ];

  switch (state) {
    case "connecting":
      return {
        title: zh ? "正在连接中转服务…" : "Connecting relay service…",
        description: zh
          ? "正在建立手机与远控中转服务的连接。"
          : "Establishing a connection between your phone and the relay.",
        steps,
      };
    case "authenticating":
      return {
        title: zh ? "正在认证设备…" : "Authenticating device…",
        description: zh
          ? "已连接中转服务，正在完成远控身份校验。"
          : "Relay connected. Verifying your remote-control identity.",
        steps,
      };
    case "waiting":
      return {
        title: zh ? "等待桌面端确认配对…" : "Waiting for desktop pairing…",
        description: zh
          ? "手机端已就绪，等待桌面端会话匹配当前连接。"
          : "Phone is ready. Waiting for desktop to match this connection.",
        steps,
      };
    case "reconnecting":
      return {
        title: zh ? "连接中断，正在重连…" : "Connection interrupted, reconnecting…",
        description: zh
          ? "网络或休眠恢复后会自动重连，请稍候。"
          : "Auto-reconnecting after network or wake-up changes.",
        steps,
      };
    case "paired":
      return {
        title: zh ? "已配对，正在加载工作区…" : "Paired. Loading workspace…",
        description: zh
          ? "连接已建立，正在同步桌面端工作区和任务。"
          : "Connection established. Syncing workspace and tasks.",
        steps,
      };
    case "suspended":
      return {
        title: zh ? "页面在后台，等待恢复…" : "Page is in background, waiting to recover…",
        description: zh
          ? "回到前台后会自动恢复连接。"
          : "Connection will recover automatically when back in foreground.",
        steps,
      };
    default:
      return {
        title: zh ? "正在准备远程控制…" : "Preparing remote control…",
        description: zh
          ? "正在初始化手机端远程控制会话。"
          : "Initializing mobile remote-control session.",
        steps,
      };
  }
}

function WebRemoteControlLoadingScreen({
  state,
}: {
  state: WebRemoteControlTerminalTransportState;
}) {
  const copy = resolveWebRemoteControlLoadingCopy(state);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-warning animate-pulse" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <div className="mt-4 grid gap-2">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
              >
                {`${index + 1}. ${step}`}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function renderWebRemoteControlLoading(state: WebRemoteControlTerminalTransportState): void {
  document.title = "ZCode - Web Remote Control";
  root.render(<WebRemoteControlLoadingScreen state={state} />);
}

async function bootstrapExternalRelayWebRemoteControl(params: URLSearchParams): Promise<void> {
  const relayParams = parseWebRemoteControlExternalQrParams(params);
  if (!relayParams) {
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "invalid-mobile-connection",
        "Missing or invalid Web remote control relay parameters.",
      ),
    );
    return;
  }

  seedWebRemoteControlThemePreference(relayParams.theme);
  seedStableWebRemoteControlClientId(relayParams.deviceSid);

  let bootstrapping = false;
  let recovering = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message === "Web remote control relay did not recover before timeout."
    ) {
      // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
      // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
      // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
      // 保证错误语义单一且稳定。
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) {
      return;
    }
    sendMobileFailureDiagnostic(failure);
    terminated = true;
    versionGuard.dispose();
    disposeVersionInputGuard();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    renderWebRemoteControlFailure(failure);
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  const recoverVisibleSession = async (reason: string): Promise<void> => {
    if (recovering || isPageUnloading || terminated || versionGuard.isBlocked()) {
      return;
    }
    recovering = true;
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    currentRecoveryId = createWebRemoteControlRequestId("recovery");
    const requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    bootstrapping = true;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          return;
        }
      }
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading) {
        // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
        // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
        // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
        transport.recoverInBackground();
      }
    } finally {
      recovering = false;
      bootstrapping = false;
    }
  };

  renderWebRemoteControlLoading("connecting");

  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    passHash: relayParams.passHash,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
    onRawTransportPayload: (payload) => activeRelayProtocol?.acceptPayload(payload) ?? false,
    onRawTransportFault: (reasonCode) => {
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // Bugfix: 远程 session 关闭会异步通知当前 bridge 失效，不对应任何 pending request。
          // 这里按硬恢复重建视图，让断开的远程 workspace 回到 home-only/reconnect 状态。
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      terminalTransportState = state;
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state);
      }
      if (state !== "paired") {
        return;
      }
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && pendingVersionCheck) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      if (activeRelayProtocol?.isDegraded()) return;
      // Bug 修复：same-socket matched 只说明 relay 当前重新可达，desktop peer 可能已经换代，
      // 也可能只丢了上一批 data/ACK。重放同 bridge 未 ACK 批次，由 messageSeq 去重；
      // adapter 继续保留原始 45 秒 age，避免心跳把不可恢复链路无限续命。
      activeRelayProtocol?.replayUnacknowledged();
    },
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
      // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: relayParams.appVersion,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    isSwitchingWebRemoteControlWorkspace = true;
    try {
      const bridgeSessionId = createWebRemoteControlRequestId("bridge");
      const bridgeGeneration = ++nextBridgeGeneration;
      const response = await requestWithRelayRecovery(() =>
        requestAppPayload(
          {
            zcode_type: "workspace-bridge-open",
            requestId: createWebRemoteControlRequestId("workspace-bridge"),
            bridgeSessionId,
            bridgeGeneration,
            ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
            workspaceKey,
            ...(options?.taskId ? { taskId: options.taskId } : {}),
          },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-bridge-ready" }
          > =>
            payload.zcode_type === "workspace-bridge-ready" &&
            payload.bridgeSessionId === bridgeSessionId,
        ),
      );
      currentRecoveryId = undefined;
      if (terminated || versionGuard.isBlocked()) {
        throw new Error(
          "Web remote control version changed before the workspace bridge was ready.",
        );
      }
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: response.bridge.bridgeSessionId,
        bridgeGeneration: response.bridge.bridgeGeneration,
        recoveryId: response.bridge.recoveryId,
        measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
        sendFrame: (frame) => {
          if (versionGuard.isBlocked()) return false;
          const result = transport.sendPayloadResult(frame);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });
      relayProtocol.onDegraded((fault) => {
        if (activeRelayProtocol !== relayProtocol) return;
        if (!import.meta.env.PROD) {
          console.warn("[web-remote-control] raw relay bridge degraded", {
            bridgeSessionId: relayProtocol.getBridgeSessionId(),
            reasonCode: fault.reasonCode,
          });
        }
        void recoverVisibleSession(fault.reasonCode);
      });
      const services = connectViaProtocol(relayProtocol.protocol);
      const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
        bridge: response.bridge,
        services,
      });
      // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
      void markOpenedWebRemoteControlBridgeTaskRead({
        bridge: response.bridge,
        expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
        services,
      });
      const previousRelayProtocol = activeRelayProtocol;
      const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
      activeRelayProtocol = relayProtocol;
      activeBridgeServiceRegistration = bridgeServiceRegistration;
      previousRelayProtocol?.dispose();
      previousBridgeServiceRegistration?.dispose();
      currentWorkspaceKey = response.bridge.workspaceKey;
      currentTaskId = response.bridge.initialTaskId;
      await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
      return { bridge: response.bridge, services, relayProtocol };
    } finally {
      isSwitchingWebRemoteControlWorkspace = false;
    }
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    const initialResult = await listWorkspaces();
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
            initialWebRemoteControlWorkspaceList={initialResult}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) === options.preferredWorkspaceKey,
        )
      : undefined;
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(preferredWorkspace.workspaceIdentity && preferredWorkspace.remoteSessionId),
        }
      : selectInitialWebRemoteControlWorkspace(bootstrapResult);
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // Bugfix: 移动端 hidden/pagehide 后 JS 定时器和 WebSocket 都可能被系统暂停。
      // 这里只保存当前 workspace/task 并暂停心跳，不做刷新；回到前台后再重连并重新 bootstrap。
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  window.addEventListener(
    "beforeunload",
    () => {
      terminated = true;
      versionGuard.dispose();
      disposeVersionInputGuard();
      disposeVersionNotice?.();
      activeBridgeServiceRegistration?.dispose();
      activeBridgeServiceRegistration = undefined;
      lifecycle.dispose();
    },
    { once: true },
  );
  transport.start();
}

async function bootstrapWebRemoteControlByToken(params: URLSearchParams): Promise<void> {
  const remoteControlToken = params.get("remoteControlToken")?.trim();
  if (!remoteControlToken) {
    return;
  }

  const relayOrigin = params.get("relayOrigin")?.trim() || window.location.origin;
  let activeBridgeSocket: WebSocket | null = null;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let pendingMobileNavigationIntent: WebRemoteControlMobileNavigationIntent | undefined;
  let webRemoteControlCloseFailure: WebRemoteControlFailure | null = null;

  const renderFailure = (failure: WebRemoteControlFailure) => {
    webRemoteControlCloseFailure = failure;
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    renderWebRemoteControlFailure(failure);
  };

  const bootstrapProxy = { token: remoteControlToken, relayOrigin };
  const snapshot = await requestWebRemoteControlWindowBootstrap(bootstrapProxy);
  const windowConnection = await connectWebRemoteControlWindow(bootstrapProxy, (event) => {
    if (isPageUnloading) {
      return;
    }
    renderFailure(mapWebRemoteControlSocketCloseToFailure(event));
  });
  const proxy: WebRemoteControlProxyOptions = {
    token: remoteControlToken,
    relayOrigin,
    windowControlSessionId: windowConnection.ready.windowControlSessionId,
    mobileConnectionId: windowConnection.ready.mobileConnectionId,
  };

  const renderBridgeRoot = (
    services: Awaited<ReturnType<typeof connectViaWebSocket>>,
    bridge: WebRemoteControlWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    const initialWorkspaceIdentity =
      bridge.kind === "remote" ? bridge.workspaceIdentity : undefined;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({ webRemoteControlProxy: proxy })}
            // 与 external relay 保持相同的 Renderer 投影；普通 Web Server Root 继续使用默认关闭。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={initialWorkspaceIdentity}
            initialTaskId={bridge.initialTaskId}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces: () =>
                requestWebRemoteControlWorkspaces(proxy).then((result) => ({
                  ...result,
                  activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
                  activeTaskId: result.activeTaskId ?? currentTaskId,
                })),
              switchWorkspace: async (workspaceKey, options) => {
                await openWorkspaceBridge(workspaceKey, options);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                pendingMobileNavigationIntent = options?.mobileNavigationIntent;
                await openWorkspaceBridge(workspaceKey, undefined);
              },
              updateMobileViewState: async (workspaceKey, taskId) => {
                currentWorkspaceKey = workspaceKey;
                currentTaskId = taskId;
                await updateWebRemoteControlMobileViewState(proxy, workspaceKey, taskId);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void> => {
    isSwitchingWebRemoteControlWorkspace = true;
    pendingMobileNavigationIntent = options?.mobileNavigationIntent;
    let bridgeSocket: WebSocket | null = null;
    try {
      const bridge = await requestWebRemoteControlWorkspaceBridge(proxy, workspaceKey, options);
      const services = await connectViaWebSocket(bridge.wsUrl, {
        onOpenSocket: (socket) => {
          bridgeSocket = socket;
        },
        onClose: (event) => {
          if (
            isPageUnloading ||
            isSwitchingWebRemoteControlWorkspace ||
            bridgeSocket !== activeBridgeSocket
          ) {
            return;
          }

          renderFailure(mapWebRemoteControlSocketCloseToFailure(event));
        },
      });
      const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
        bridge,
        services,
      });
      // 已读写入失败由 helper 记录，导航继续使用已经建立的目标 bridge。
      void markOpenedWebRemoteControlBridgeTaskRead({
        bridge,
        expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
        services,
      });

      const previousBridgeSocket = activeBridgeSocket;
      const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
      activeBridgeSocket = bridgeSocket;
      activeBridgeServiceRegistration = bridgeServiceRegistration;
      previousBridgeSocket?.close();
      previousBridgeServiceRegistration?.dispose();
      currentWorkspaceKey = bridge.workspaceKey;
      currentTaskId = bridge.initialTaskId;
      await updateWebRemoteControlMobileViewState(proxy, bridge.workspaceKey, bridge.initialTaskId);
      const initialNavigationIntent = pendingMobileNavigationIntent;
      pendingMobileNavigationIntent = undefined;
      renderBridgeRoot(services, bridge, initialNavigationIntent);
    } finally {
      pendingMobileNavigationIntent = undefined;
      isSwitchingWebRemoteControlWorkspace = false;
    }
  };

  const selectedWorkspace = selectInitialWebRemoteControlWorkspace(snapshot);
  if (!selectedWorkspace) {
    throw toWebRemoteControlFailure(
      "workspace-closed",
      "No opened desktop workspace is available for Web remote control.",
    );
  }

  try {
    await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
  } catch (error) {
    windowConnection.socket.close();
    throw error;
  }

  if (webRemoteControlCloseFailure) {
    windowConnection.socket.close();
  }
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  if (isWebRemoteControlRoute()) {
    await bootstrapExternalRelayWebRemoteControl(params);
    return;
  }

  if (params.has("remoteControlToken")) {
    try {
      await bootstrapWebRemoteControlByToken(params);
    } catch (error) {
      renderWebRemoteControlFailure(
        error && typeof error === "object" && "reason" in error
          ? (error as WebRemoteControlFailure)
          : toWebRemoteControlFailure(
              "unexpected-error",
              error instanceof Error ? error.message : String(error),
            ),
      );
    }
    return;
  }

  if (shouldUseWebRemoteAuth(params)) {
    const auth = await webAuthService.restoreCachedSession();
    if (!auth) {
      renderWebLoginPage();
      return;
    }

    renderWebLoggedInWaitingPage(auth);
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  try {
    const services = await connectViaWebSocket(bootstrap.wsUrl, {
      onClose: () => {},
    });
    const platform = createWebPlatform();
    document.title = "ZCode - Web + Server";

    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            initialTaskId={bootstrap.initialTaskId}
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
  }
}

void bootstrapWebApp();
