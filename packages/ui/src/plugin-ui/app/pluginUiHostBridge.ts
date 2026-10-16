import type {
  CallToolRequest,
  CreateMessageRequest,
  CreateMessageResult,
  CallToolResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  LoggingMessageNotification,
  ReadResourceRequest,
  ReadResourceResult,
  Transport,
} from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiDownloadFileRequest,
  McpUiDownloadFileResult,
  McpUiHostContext,
  McpUiOpenLinkRequest,
  McpUiRequestDisplayModeRequest,
  McpUiSizeChangedNotification,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/** 官方 SDK 请求 handler 的上下文子集：中止信号在 `ctx.mcpReq.signal`。 */
export interface PluginUiRequestContext {
  mcpReq?: { signal?: AbortSignal };
}

/**
 * 控制器用到的官方 `AppBridge` 成员子集。生产用 `new AppBridge(null, …)`，测试可注入假实现。
 * 自定义方法（ZCode 扩展与需要放宽 schema 的 ui/message）走基类的三参 `setRequestHandler`；
 * 规范方法（resources/subscribe）走二参形式，handler 拿到完整 request。
 */
export interface PluginUiHostBridge {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  setHostContext(hostContext: McpUiHostContext): void;
  sendToolInput(params: McpUiToolInputNotification["params"]): Promise<void>;
  sendToolResult(params: McpUiToolResultNotification["params"]): Promise<void>;
  sendToolCancelled(params: McpUiToolCancelledNotification["params"]): Promise<void>;
  teardownResource(
    params: Record<string, never>,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /** `initialized` 之后可读；页面声明的 availableDisplayModes 决定宿主能否切它到 fullscreen。 */
  getAppCapabilities(): McpUiAppCapabilities | undefined;
  notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
  /** App-Provided Tools：宿主发现页面工具、把模型调用交给页面执行。 */
  listTools(
    params: ListToolsRequest["params"],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<CallToolResult>;
  setNotificationHandler(
    method: "notifications/tools/list_changed",
    handler: (notification: unknown) => void,
  ): void;
  setRequestHandler(
    method: "resources/subscribe" | "resources/unsubscribe",
    handler: (
      request: { params: { uri: string } },
      ctx: PluginUiRequestContext,
    ) => Promise<Record<string, never>>,
  ): void;
  setRequestHandler(
    method: string,
    schemas: { params: unknown; result?: unknown },
    handler: (params: unknown, ctx: PluginUiRequestContext) => Promise<unknown>,
  ): void;
  oninitialized: (() => void) | undefined;
  oncreatesamplingmessage:
    | ((
        params: CreateMessageRequest["params"],
        ctx: PluginUiRequestContext,
      ) => Promise<CreateMessageResult>)
    | undefined;
  oncalltool:
    | ((params: CallToolRequest["params"], ctx: PluginUiRequestContext) => Promise<CallToolResult>)
    | undefined;
  onreadresource:
    | ((params: ReadResourceRequest["params"], ctx: unknown) => Promise<ReadResourceResult>)
    | undefined;
  onlistresources:
    | ((params: ListResourcesRequest["params"], ctx: unknown) => Promise<ListResourcesResult>)
    | undefined;
  onlistresourcetemplates:
    | ((
        params: ListResourceTemplatesRequest["params"],
        ctx: unknown,
      ) => Promise<ListResourceTemplatesResult>)
    | undefined;
  onopenlink: ((params: McpUiOpenLinkRequest["params"], ctx: unknown) => Promise<{}>) | undefined;
  onrequestdisplaymode:
    | ((
        params: McpUiRequestDisplayModeRequest["params"],
        ctx: unknown,
      ) => Promise<{ mode: McpUiDisplayMode }>)
    | undefined;
  onupdatemodelcontext:
    | ((params: McpUiUpdateModelContextRequest["params"], ctx: unknown) => Promise<{}>)
    | undefined;
  ondownloadfile:
    | ((
        params: McpUiDownloadFileRequest["params"],
        ctx: unknown,
      ) => Promise<McpUiDownloadFileResult>)
    | undefined;
  onrequestteardown: (() => void) | undefined;
  onsizechange: ((params: McpUiSizeChangedNotification["params"]) => void) | undefined;
  onloggingmessage: ((params: LoggingMessageNotification["params"]) => void) | undefined;
}
