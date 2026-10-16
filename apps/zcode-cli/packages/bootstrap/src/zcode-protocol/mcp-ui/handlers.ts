import type { Logger } from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";
import {
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  isMcpAppsUiReadResourceMimeAllowed,
} from "@zcode/shared/mcp-apps";
import type {
  McpUiCallToolParams,
  McpUiCallToolResult,
  McpUiCancelCallParams,
  McpUiCancelCallResult,
  McpUiHandlers,
  McpUiListResourceTemplatesResult,
  McpUiListResourcesParams,
  McpUiListResourcesResult,
  McpUiPluginScope,
  McpUiReadResourceForUiResult,
  McpUiReadResourceParams,
  McpUiReadResourceResult,
  McpUiResourceContent,
  McpUiResourceSubscriptionParams,
  McpUiSessionAccess,
} from "./contract.js";
import {
  McpUiNotSupportedError,
  McpUiResourceRejectedError,
  McpUiServerScopeError,
  McpUiToolAccessError,
  buildMcpUiSubscriberKey,
} from "./contract.js";

/**
 * 进行中的 UI 工具调用，键 = sessionId + callId。唯一 owner；调用结束即删。
 * 模块级而不是 handlers 实例级：protocol.ts 每次请求都新建 handlers，取消请求必须能找到别的请求登记的调用。
 */
const activeUiToolCalls = new Map<string, AbortController>();
const finishedUiToolCalls = new Set<string>();
const uiToolCallKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

/** 供 session 关闭时清理：abort 该 session 全部进行中的 UI 调用。 */
export function abortMcpUiToolCallsForSession(sessionId: string): number {
  for (const key of finishedUiToolCalls)
    if (key.startsWith(`${sessionId}\u0000`)) finishedUiToolCalls.delete(key);
  let count = 0;
  for (const [key, controller] of activeUiToolCalls) {
    if (!key.startsWith(`${sessionId}\u0000`)) continue;
    controller.abort();
    activeUiToolCalls.delete(key);
    count += 1;
  }
  return count;
}

export interface CreateMcpUiHandlersOptions {
  logger?: Logger;
}

/** 归属校验 fail closed：serverName 不在本 session 的 MCP server 表里一律 -32602；pluginId 不参与判定。 */
export async function assertMcpUiServerScope(
  access: McpUiSessionAccess,
  scope: McpUiPluginScope,
): Promise<void> {
  if (!(await access.hasMcpServer(scope.serverName))) {
    throw new McpUiServerScopeError(scope.serverName);
  }
}

export function createMcpUiHandlers(options: CreateMcpUiHandlersOptions = {}): McpUiHandlers {
  const logger = options.logger?.child?.({ module: "bootstrap.mcp-ui" }) ?? options.logger;
  return {
    async readResource(
      access: McpUiSessionAccess,
      params: McpUiReadResourceParams,
      callOptions,
    ): Promise<McpUiReadResourceResult> {
      await assertMcpUiServerScope(access, params);
      return access.readResource(params.serverName, params.uri, callOptions);
    },
    async callTool(
      access: McpUiSessionAccess,
      params: McpUiCallToolParams,
      callOptions,
    ): Promise<McpUiCallToolResult> {
      const startedAt = Date.now();
      // H08-a：带 callId 的调用登记 AbortController，宿主卸载卡片时经 mcp/uiCancelCall abort 到 MCP client。
      const cancel = new AbortController();
      const key = uiToolCallKey(params.sessionId, `${params.instance.token}:${params.callId}`);
      if (activeUiToolCalls.has(key) || finishedUiToolCalls.has(key))
        throw new Error("Duplicate MCP App callId");
      activeUiToolCalls.set(key, cancel);
      const signal = callOptions?.signal
        ? AbortSignal.any([callOptions.signal, cancel.signal])
        : cancel.signal;
      try {
        await assertMcpUiServerScope(access, params);
        // H03：归属之外还要看调用方资格——model-only 工具不给页面调，权限仍由现有宿主策略判断。
        const visibility = await access.getToolVisibility(params.serverName, params.toolName);
        if (!visibility) {
          throw new McpUiToolAccessError("tool_not_found", params.serverName, params.toolName);
        }
        if (!visibility.includes("app")) {
          throw new McpUiToolAccessError(
            "tool_not_app_visible",
            params.serverName,
            params.toolName,
          );
        }
        signal?.throwIfAborted();
        const result = await access.callTool(params.serverName, params.toolName, params.arguments, {
          signal,
        });
        signal?.throwIfAborted();
        // UI 调用复用宿主权限链，结果保留原始 MCP 形状，不生成对话回合。
        logger?.info("MCP UI tool call completed", {
          event: "mcp.ui.tool.call",
          pluginId: params.pluginId,
          mcpServerName: params.serverName,
          mcpToolName: params.toolName,
          durationMs: Date.now() - startedAt,
          isError: result.isError === true,
          status: "completed",
        });
        return result;
      } catch (error) {
        logger?.warn("MCP UI tool call failed", {
          event: "mcp.ui.tool.call",
          pluginId: params.pluginId,
          mcpServerName: params.serverName,
          mcpToolName: params.toolName,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          status: cancel?.signal.aborted ? "cancelled" : "failed",
        });
        throw error;
      } finally {
        if (activeUiToolCalls.get(key) === cancel) {
          activeUiToolCalls.delete(key);
          finishedUiToolCalls.add(key);
        }
      }
    },
    async cancelToolCall(
      access: McpUiSessionAccess,
      params: McpUiCancelCallParams,
    ): Promise<McpUiCancelCallResult> {
      await assertMcpUiServerScope(access, params);
      const key = uiToolCallKey(params.sessionId, `${params.instance.token}:${params.callId}`);
      const controller = activeUiToolCalls.get(key);
      if (!controller) {
        finishedUiToolCalls.add(key);
        return { cancelled: false };
      }
      controller.abort();
      finishedUiToolCalls.add(key);
      logger?.info("MCP UI tool call cancelled", {
        event: "mcp.ui.tool.cancel",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        callId: params.callId,
      });
      return { cancelled: true };
    },
    async listResources(
      access: McpUiSessionAccess,
      params: McpUiListResourcesParams,
      callOptions,
    ): Promise<McpUiListResourcesResult> {
      await assertMcpUiServerScope(access, params);
      const result = await translateUnsupported(params.serverName, "resources/list", () =>
        access.listResourcesForUi(params.serverName, params.cursor, callOptions),
      );
      // 只给页面标准描述符；`_meta` 是 MCP Resource 的标准字段，保留（宿主也靠它回退读资源级 csp）。
      return {
        resources: result.resources.map(({ uri, name, title, description, mimeType, _meta }) => ({
          uri,
          ...(name !== undefined ? { name } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(mimeType !== undefined ? { mimeType } : {}),
          ...(_meta !== undefined ? { _meta } : {}),
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    async listResourceTemplates(
      access: McpUiSessionAccess,
      params: McpUiListResourcesParams,
      callOptions,
    ): Promise<McpUiListResourceTemplatesResult> {
      await assertMcpUiServerScope(access, params);
      const result = await translateUnsupported(params.serverName, "resources/templates/list", () =>
        access.listResourceTemplatesForUi(params.serverName, params.cursor, callOptions),
      );
      return {
        resourceTemplates: result.resourceTemplates.map(
          ({ uriTemplate, name, title, description, mimeType }) => ({
            uriTemplate,
            ...(name !== undefined ? { name } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(mimeType !== undefined ? { mimeType } : {}),
          }),
        ),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    async subscribeResource(
      access: McpUiSessionAccess,
      params: McpUiResourceSubscriptionParams,
      callOptions,
    ): Promise<void> {
      await assertMcpUiServerScope(access, params);
      if (
        params.scopeId !== params.instance.token ||
        params.generation !== params.instance.generation
      )
        throw new Error("Invalid MCP App subscription binding");
      const key = buildMcpUiSubscriberKey(params.sessionId, params.scopeId, params.generation);
      await translateUnsupported(params.serverName, "resources/subscribe", () =>
        access.subscribeResourceForUi(params.serverName, params.uri, key, callOptions),
      );
      logger?.info("MCP UI resource subscribed", {
        event: "mcp.ui.resource.subscribe",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        uri: params.uri,
        scopeId: params.scopeId,
        generation: params.generation,
      });
    },
    async unsubscribeResource(
      access: McpUiSessionAccess,
      params: McpUiResourceSubscriptionParams,
      callOptions,
    ): Promise<void> {
      await assertMcpUiServerScope(access, params);
      if (
        params.scopeId !== params.instance.token ||
        params.generation !== params.instance.generation
      )
        throw new Error("Invalid MCP App subscription binding");
      const key = buildMcpUiSubscriberKey(params.sessionId, params.scopeId, params.generation);
      await access.unsubscribeResourceForUi(params.serverName, params.uri, key, callOptions);
    },
    async readResourceForUi(
      access: McpUiSessionAccess,
      params: McpUiReadResourceParams,
      callOptions,
    ): Promise<McpUiReadResourceForUiResult> {
      await assertMcpUiServerScope(access, params);
      const startedAt = Date.now();
      const raw = await access.readResourceForUi(params.serverName, params.uri, callOptions);
      const result = boundUiResourceContents(params.uri, raw.contents);
      logger?.info("MCP UI resource read completed", {
        event: "mcp.ui.resource.read",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        uri: params.uri,
        durationMs: Date.now() - startedAt,
        bytes: result.bytes,
        status: "completed",
      });
      return { contents: result.contents };
    },
  };
}

async function translateUnsupported<T>(
  serverName: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpResourceSubscribeUnsupportedError) {
      throw new McpUiNotSupportedError(serverName, operation);
    }
    throw error;
  }
}

/**
 * 页面读资源的边界：总大小（text 按 UTF-8、blob 按 base64 解码后）≤ 8 MiB，mimeType 必须在白名单；
 * blob 没有 mimeType 视为不可判定，一律拒绝；去掉 `_meta`。超限不截断——半个 GLB / 图片没有意义。
 */
function boundUiResourceContents(
  uri: string,
  contents: readonly McpUiResourceContent[],
): { contents: McpUiReadResourceForUiResult["contents"]; bytes: number } {
  let bytes = 0;
  const bounded: McpUiReadResourceForUiResult["contents"] = [];
  for (const content of contents) {
    const mimeType = content.mimeType;
    if (mimeType !== undefined && !isMcpAppsUiReadResourceMimeAllowed(mimeType)) {
      throw new McpUiResourceRejectedError("mime_not_allowed", content.uri || uri, { mimeType });
    }
    if (content.blob !== undefined && mimeType === undefined) {
      throw new McpUiResourceRejectedError("mime_not_allowed", content.uri || uri, {
        mimeType: "(missing)",
      });
    }
    if (content.text !== undefined) bytes += Buffer.byteLength(content.text, "utf8");
    if (content.blob !== undefined) bytes += Buffer.byteLength(content.blob, "base64");
    if (bytes > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
      throw new McpUiResourceRejectedError("too_large", uri, {
        bytes,
        maxBytes: MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
      });
    }
    bounded.push({
      uri: content.uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    });
  }
  return { contents: bounded, bytes };
}

/** 页面的凭证终结时释放幂等账本；旧凭证已经不可再执行。 */
export function clearMcpUiInstanceCalls(sessionId: string, token: string): void {
  const prefix = `${sessionId}\u0000${token}:`;
  for (const [key, controller] of activeUiToolCalls)
    if (key.startsWith(prefix)) {
      activeUiToolCalls.delete(key);
      controller.abort();
    }
  for (const key of finishedUiToolCalls)
    if (key.startsWith(prefix)) finishedUiToolCalls.delete(key);
}
