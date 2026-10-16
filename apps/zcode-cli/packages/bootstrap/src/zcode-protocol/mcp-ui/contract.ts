/**
 * mcp-ui 契约：UI 发起的 MCP 资源读取与工具调用在 agent 侧的处理器接口。
 * 参数与结果形状与 `@zcode/shared` 的 `zcodeMcpReadResource*` / `zcodeMcpUiCallTool*` schema 同构，
 * 由 contract.test 断言两者一致。
 */

import type {
  McpUiPluginScope,
  McpUiResourceHandlers,
  McpUiResourceSessionAccess,
} from "./resourceContract.js";
export * from "./resourceContract.js";

export interface McpUiReadResourceParams extends McpUiPluginScope {
  uri: string;
}

export interface McpUiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpUiReadResourceResult {
  contents: McpUiResourceContent[];
}

/** 页面发起的 resources/read 结果：无 `_meta`，每项 text 或 blob（base64）二选一。 */
export interface McpUiReadResourceForUiResult {
  contents: Array<Pick<McpUiResourceContent, "uri" | "mimeType" | "text" | "blob">>;
}

export interface McpUiCallToolParams extends McpUiPluginScope {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的必填调用 id；接纳、取消与终态去重共用。 */
  callId: string;
}

export interface McpUiCancelCallParams extends McpUiPluginScope {
  callId: string;
}
export interface McpUiCancelCallResult {
  /** false = 没有这个进行中的调用（已完成或尚未接纳）。 */
  cancelled: boolean;
}

export interface McpUiCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * 处理器依赖的最小 session 视图：由 bootstrap 的 session record 适配，
 * 处理器不直接接触 ZCodeApp 或 mcpPort 的其余能力。
 */
export interface McpUiSessionAccess extends McpUiResourceSessionAccess {
  /** serverName 是否是本 session 已配置的 MCP server（插件 server 与普通 MCP server 同一张表）。 */
  hasMcpServer(serverName: string): Promise<boolean>;
  /** 工具可见性（`_meta.ui.visibility` 归一化结果）；工具不存在返回 null。 */
  getToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly ("model" | "app")[] | null>;
  readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiCallToolResult>;
  /** 页面发起的 resources/read（A7）；大小与 mimeType 校验在处理器完成，这里只是端口透传。 */
  readResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
}

/**
 * fail closed：serverName 不在本 session 的 MCP server 表里时抛出，映射为 JSON-RPC -32602。
 * 归属只看 server（任何已连接的 MCP server 都能渲染 MCP App）；pluginId 只用于展示与日志。
 */
export class McpUiServerScopeError extends Error {
  readonly code = -32602;
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" is not available in this session`);
    this.name = "McpUiServerScopeError";
  }
}

/**
 * UI 调用了不存在或 model-only 的工具。归属校验通过不代表调用方有资格：
 * `visibility` 不含 "app" 的工具只给模型用。映射为 JSON-RPC -32602。
 */
export class McpUiToolAccessError extends Error {
  readonly code = -32602;
  constructor(
    readonly reason: "tool_not_found" | "tool_not_app_visible",
    readonly serverName: string,
    readonly toolName: string,
  ) {
    super(
      reason === "tool_not_found"
        ? `MCP tool "${toolName}" is not available on server "${serverName}"`
        : `MCP tool "${toolName}" on server "${serverName}" is not visible to plugin UI`,
    );
    this.name = "McpUiToolAccessError";
  }
}

/** A7：结果超过 8 MiB 或 mimeType 不在白名单时抛出，映射为 JSON-RPC -32001（资源被拒）。 */
export class McpUiResourceRejectedError extends Error {
  readonly code = -32001;
  constructor(
    readonly reason: "too_large" | "mime_not_allowed",
    readonly uri: string,
    readonly detail: { bytes?: number; maxBytes?: number; mimeType?: string },
  ) {
    super(
      reason === "too_large"
        ? `MCP resource "${uri}" is ${detail.bytes} bytes, exceeding the ${detail.maxBytes} byte limit for plugin UI reads`
        : `MCP resource "${uri}" has mimeType "${detail.mimeType}" which is not allowed for plugin UI reads`,
    );
    this.name = "McpUiResourceRejectedError";
  }
}

export interface McpUiHandlers extends McpUiResourceHandlers<McpUiSessionAccess> {
  readResource(
    access: McpUiSessionAccess,
    params: McpUiReadResourceParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
  callTool(
    access: McpUiSessionAccess,
    params: McpUiCallToolParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiCallToolResult>;
  /** abort 对应 callId 的进行中调用；归属校验同 callTool。 */
  cancelToolCall(
    access: McpUiSessionAccess,
    params: McpUiCancelCallParams,
  ): Promise<McpUiCancelCallResult>;
  readResourceForUi(
    access: McpUiSessionAccess,
    params: McpUiReadResourceParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceForUiResult>;
}
