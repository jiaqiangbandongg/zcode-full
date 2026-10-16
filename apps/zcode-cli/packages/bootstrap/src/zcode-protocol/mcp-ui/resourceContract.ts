/**
 * mcp-ui 资源契约（）：resources/list、resources/templates/list 与订阅。
 * 与 `contract.ts` 分开是为了让主契约保持在公开方法上限内；处理器接口经 extends 合成。
 */
/** UI 请求的归属范围：会话 + MCP server（归属真相）+ pluginId（只做展示 / 日志；非插件 server 时等于 serverName）。 */
export interface McpUiPluginScope {
  workspace?: { workspacePath: string; workspaceIdentity?: string };
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
}

/** resources/list、resources/templates/list 与订阅的参数 / 结果。 */
export interface McpUiListResourcesParams extends McpUiPluginScope {
  cursor?: string;
}
export interface McpUiResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** 规范把资源级 csp / prefersBorder 放在 resources/list 条目的 `_meta` 上；宿主读 HTML 项缺 `_meta` 时回退到这里。 */
  _meta?: Record<string, unknown>;
}
export interface McpUiListResourcesResult {
  resources: McpUiResourceDescriptor[];
  nextCursor?: string;
}
export interface McpUiListResourceTemplatesResult {
  resourceTemplates: Array<Omit<McpUiResourceDescriptor, "uri"> & { uriTemplate: string }>;
  nextCursor?: string;
}
export interface McpUiResourceSubscriptionParams extends McpUiPluginScope {
  scopeId: string;
  generation: number;
  uri: string;
}
/** 订阅者身份 = sessionId | scopeId | generation；会话关闭按 `sessionId|` 前缀清理。 */
export function buildMcpUiSubscriberKey(
  sessionId: string,
  scopeId: string,
  generation: number,
): string {
  return `${sessionId}|${scopeId}|${generation}`;
}
export function parseMcpUiSubscriberKey(
  key: string,
): { sessionId: string; scopeId: string; generation: number } | null {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first <= 0 || last <= first) return null;
  const generation = Number(key.slice(last + 1));
  if (!Number.isInteger(generation) || generation < 0) return null;
  return { sessionId: key.slice(0, first), scopeId: key.slice(first + 1, last), generation };
}

/** server 没声明 resources.subscribe 能力（或端口不支持资源）→ -32001 not_supported。 */
export class McpUiNotSupportedError extends Error {
  readonly code = -32001;
  readonly reason = "not_supported" as const;
  constructor(
    readonly serverName: string,
    readonly operation: string,
  ) {
    super(`MCP server "${serverName}" does not support ${operation}`);
    this.name = "McpUiNotSupportedError";
  }
}

/** session 视图里的资源端口（端口透传；能力缺失由端口抛 McpResourceSubscribeUnsupportedError）。 */
export interface McpUiResourceSessionAccess {
  listResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourcesResult>;
  listResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourceTemplatesResult>;
  subscribeResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  unsubscribeResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface McpUiResourceHandlers<Access extends McpUiResourceSessionAccess> {
  listResources(
    access: Access,
    params: McpUiListResourcesParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourcesResult>;
  listResourceTemplates(
    access: Access,
    params: McpUiListResourcesParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourceTemplatesResult>;
  subscribeResource(
    access: Access,
    params: McpUiResourceSubscriptionParams,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  unsubscribeResource(
    access: Access,
    params: McpUiResourceSubscriptionParams,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
