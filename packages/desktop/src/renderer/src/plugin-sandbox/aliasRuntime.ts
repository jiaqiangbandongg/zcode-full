import type {
  CallToolResult,
  Implementation,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
  RequestOptions,
  Transport,
} from "@modelcontextprotocol/client";
import { EmptyResultSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/core";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
} from "@zcode/shared/mcp-apps";
import type { OpenAiCompatApi, ZcodeAliasApi } from "./aliasApi.js";
import { createOpenAiCompatApi, readOpenAiGlobals } from "./openaiAlias.js";

/**
 * 插件 iframe 内 `window.zcode` / `window.openai` 别名的运行时：官方 ext-apps `App` 上的薄封装，协议、握手、
 * 错误码全部来自 SDK，自己不持有 JSON-RPC。纯逻辑（消息经注入的 App 收发），alias.ts 负责接 DOM。
 *
 * 懒连接：别名脚本注入到每个插件页面，而用官方 SDK 自建 `App` 的页面（官方示例）不会碰 `window.zcode`；
 * 首次访问任一成员才握手，避免同一页面对宿主发两次 ui/initialize。
 */
export interface AliasAppLike {
  connect(transport?: Transport, options?: RequestOptions): Promise<void>;
  getHostVersion(): Implementation | undefined;
  getHostCapabilities(): McpUiHostCapabilities | undefined;
  getHostContext(): McpUiHostContext | undefined;
  ontoolinput: ((params: McpUiToolInputNotification["params"]) => void) | undefined;
  ontoolresult: ((params: McpUiToolResultNotification["params"]) => void) | undefined;
  ontoolcancelled: ((params: McpUiToolCancelledNotification["params"]) => void) | undefined;
  onhostcontextchanged: ((params: McpUiHostContext) => void) | undefined;
  callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  readServerResource(params: { uri: string }): Promise<ReadResourceResult>;
  listServerResources(params?: { cursor?: string }): Promise<ListResourcesResult>;
  /** 规范方法（resources/templates/list、resources/subscribe…）与 ZCode 扩展方法走基类 request。 */
  request(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: unknown,
  ): Promise<unknown>;
  setNotificationHandler(
    method: "notifications/resources/updated" | "notifications/resources/list_changed",
    handler: (notification: { params?: { uri?: string } }) => void,
  ): void;
  openLink(params: { url: string }): Promise<unknown>;
  requestDisplayMode(params: { mode: McpUiDisplayMode }): Promise<{ mode: McpUiDisplayMode }>;
  sendSizeChanged(params: { width?: number; height?: number }): Promise<void>;
  sendMessage(params: {
    role: "user";
    content: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  updateModelContext(params: {
    content?: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  downloadFile(params: { contents: McpAppsDownloadFileItem[] }): Promise<{ isError?: boolean }>;
}

export const ZCODE_GLOBALS_EVENT = "zcode:globals";

export interface PluginSandboxAliasRuntime {
  zcode: ZcodeAliasApi;
  openai: OpenAiCompatApi;
  /** 是否已经（或正在）握手；诊断用。 */
  readonly connecting: boolean;
  /**
   * 页面自建的官方 `App` 已在与宿主通信（别名尚未握手前就看到宿主发来的 JSON-RPC）：别名放弃握手。
   * 同一页面两个 `App` 共用一条 postMessage 通道会撞请求 id（都从 0 起）并让宿主收到两次 initialized。
   */
  markForeignApp(): void;
}

export function createPluginSandboxAliasRuntime(options: {
  app: AliasAppLike;
  /** 官方 App 的 connect 缺省用 window.parent 的 PostMessageTransport；这里注入以便控制目标窗口。 */
  transport?: Transport;
  protocolVersion: string;
  onChange?: (globals: Record<string, unknown>) => void;
}): PluginSandboxAliasRuntime {
  const { app } = options;
  let toolInput: Record<string, unknown> | null = null;
  let toolOutput: unknown = null;
  let toolResponseMetadata: Record<string, unknown> | null = null;
  let toolCancelled: { reason?: string } | null = null;
  let widgetState: unknown = null;
  let widgetStateSeeded = false;
  let connectPromise: Promise<void> | null = null;
  let foreignApp = false;
  const listeners = new Set<() => void>();
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  const resourceListChangedListeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
    options.onChange?.(readOpenAiGlobals(openai));
  };

  app.ontoolinput = (params) => {
    toolInput = params.arguments ?? {};
    notify();
  };
  app.ontoolresult = (params) => {
    toolOutput = params.structuredContent ?? null;
    toolResponseMetadata = (params._meta as Record<string, unknown> | undefined) ?? null;
    notify();
  };
  app.ontoolcancelled = (params) => {
    toolCancelled = params.reason ? { reason: params.reason } : {};
    notify();
  };
  app.onhostcontextchanged = () => notify();
  app.setNotificationHandler("notifications/resources/updated", (notification) => {
    const uri = notification.params?.uri;
    if (typeof uri !== "string") return;
    for (const listener of resourceUpdatedListeners) listener(uri);
  });
  app.setNotificationHandler("notifications/resources/list_changed", () => {
    for (const listener of resourceListChangedListeners) listener();
  });

  /** 失败只记录一次，后续访问不重试（与页面自建 App 的失败语义一致）。 */
  const ready = (): Promise<void> => {
    if (foreignApp && !connectPromise) {
      return Promise.reject(
        new Error(
          "window.zcode is unavailable: this page already connected its own MCP Apps App; use it directly",
        ),
      );
    }
    if (!connectPromise) {
      connectPromise = app.connect(options.transport).then(
        () => {
          // widgetState 初值随握手经 hostContext 扩展键下发（宿主只在创建桥时带一次）。
          if (!widgetStateSeeded) {
            widgetStateSeeded = true;
            const seeded = (app.getHostContext() as Record<string, unknown> | undefined)?.[
              MCP_APPS_WIDGET_STATE_CONTEXT_KEY
            ];
            if (seeded !== undefined) widgetState = seeded;
          }
          notify();
        },
        (error) => {
          console.warn("[plugin-sandbox-alias] connect failed", error);
          throw error;
        },
      );
    }
    return connectPromise;
  };
  const whenReady = <T>(run: () => Promise<T>): Promise<T> => ready().then(run);

  const hostContext = () => app.getHostContext() ?? null;
  const zcodeTarget: ZcodeAliasApi = {
    get toolInput() {
      return toolInput;
    },
    get toolOutput() {
      return toolOutput;
    },
    get toolResponseMetadata() {
      return toolResponseMetadata;
    },
    get toolCancelled() {
      return toolCancelled;
    },
    get theme() {
      return hostContext()?.theme ?? null;
    },
    get locale() {
      return hostContext()?.locale ?? null;
    },
    get displayMode() {
      return hostContext()?.displayMode ?? null;
    },
    get maxHeight() {
      // SDK 把 containerDimensions 建成 height|maxHeight 的联合，两个分支都可能带值，按对象读。
      const dimensions = hostContext()?.containerDimensions as
        | { height?: number; maxHeight?: number }
        | undefined;
      return dimensions?.maxHeight ?? dimensions?.height ?? null;
    },
    get safeArea() {
      return hostContext()?.safeAreaInsets ?? null;
    },
    get userAgent() {
      return hostContext()?.userAgent ?? null;
    },
    get hostInfo() {
      return app.getHostVersion() ?? null;
    },
    get hostCapabilities() {
      return app.getHostCapabilities() ?? null;
    },
    get hostContext() {
      return hostContext();
    },
    get protocolVersion() {
      return app.getHostVersion() ? options.protocolVersion : null;
    },
    callTool: (name, args) =>
      whenReady(() => app.callServerTool({ name, ...(args ? { arguments: args } : {}) })),
    readResource: (uri) => whenReady(() => app.readServerResource({ uri })),
    listResources: (input) =>
      whenReady(() => app.listServerResources(input?.cursor ? { cursor: input.cursor } : {})),
    listResourceTemplates: (input) =>
      whenReady(
        () =>
          app.request(
            {
              method: "resources/templates/list",
              params: input?.cursor ? { cursor: input.cursor } : {},
            },
            ListResourceTemplatesResultSchema,
          ) as Promise<ListResourceTemplatesResult>,
      ),
    subscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/subscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    unsubscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/unsubscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    onResourceUpdated(listener) {
      resourceUpdatedListeners.add(listener);
      return () => resourceUpdatedListeners.delete(listener);
    },
    onResourceListChanged(listener) {
      resourceListChangedListeners.add(listener);
      return () => resourceListChangedListeners.delete(listener);
    },
    requestDisplayMode: (input) => whenReady(() => app.requestDisplayMode(input)),
    openExternal(input) {
      void whenReady(() => app.openLink({ url: input.href })).catch(() => undefined);
    },
    downloadFile: (contents) => whenReady(() => app.downloadFile({ contents })),
    notifyIntrinsicHeight(height) {
      void whenReady(() => app.sendSizeChanged({ height })).catch(() => undefined);
    },
    get widgetState() {
      return widgetState;
    },
    setWidgetState(state) {
      widgetState = state;
      notify();
      return whenReady(() =>
        app.request(
          { method: MCP_APPS_SET_WIDGET_STATE_METHOD, params: { widgetState: state } },
          EmptyResultSchema,
        ),
      ).then(() => undefined);
    },
    sendFollowUpMessage: (input) =>
      whenReady(() =>
        app.sendMessage({
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    updateModelContext: (input) =>
      whenReady(() =>
        app.updateModelContext({
          ...(input.content ? { content: input.content } : {}),
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
  };
  // 任一成员首次被访问即触发握手（读 toolInput 也算：页面通常先读再等事件）。
  const lazy = <T extends object>(target: T): T =>
    new Proxy(Object.freeze(target), {
      get(object, key, receiver) {
        if (typeof key === "string") void ready().catch(() => undefined);
        return Reflect.get(object, key, receiver);
      },
    });
  const zcode = lazy(zcodeTarget);
  const openai = lazy(createOpenAiCompatApi(zcodeTarget));

  return {
    zcode,
    openai,
    get connecting() {
      return connectPromise !== null;
    },
    markForeignApp() {
      if (!connectPromise) foreignApp = true;
    },
  };
}
