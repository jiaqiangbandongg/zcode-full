import {
  SessionEventType,
  createEventId,
  type PluginUiAppToolCallRequestedPayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  zcodeMcpUiClaimAppToolCallParamsSchema,
  zcodeMcpUiRegisterAppToolsParamsSchema,
  zcodeMcpUiResolveAppToolCallParamsSchema,
  zcodeMcpUiUnregisterAppToolsParamsSchema,
  type ZCodeMcpUiAppToolAcceptedResult,
  type ZCodeMcpUiRegisterAppToolsResult,
  type ZCodeMcpUiUnregisterAppToolsResult,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "../server-types.js";
import { McpUiAppToolRegistry } from "./appTools.js";
import { McpUiServerScopeError } from "./contract.js";
import { assertMcpUiServerScope } from "./handlers.js";
import { mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";

/**
 * App-Provided Tools 的四个协议方法。登记表按 agent 进程（context）唯一；信箱投递用 v4Gateway.ingest 的
 * live-only 事件（seq 0），与资源通知同一条路。
 */
const registries = new WeakMap<ZCodeProtocolAgentServerContext, McpUiAppToolRegistry>();

export function getMcpUiAppToolRegistry(
  context: ZCodeProtocolAgentServerContext,
): McpUiAppToolRegistry {
  let registry = registries.get(context);
  if (!registry) {
    registry = new McpUiAppToolRegistry({
      applyTools: (sessionId, definitions, execute) => {
        const record = context.sessions.get(sessionId);
        return record
          ? record.app.replaceMcpAppProvidedTools(
              definitions.map((definition) => ({
                ...definition,
                retainExecution: (callId: string) =>
                  mcpUiInstances.retain(definition.scopeId, callId),
              })),
              execute,
            )
          : null;
      },
      publishCall: (sessionId, target, call) => {
        const record = context.sessions.get(sessionId);
        if (!record || !context.v4Gateway) return;
        const payload: PluginUiAppToolCallRequestedPayload = {
          pluginId: target.pluginId,
          serverName: target.serverName,
          subscribers: [{ ...target.instance, instance: target.credential }],
          cancelled: call.cancelled,
          callId: call.callId,
          toolName: call.toolName,
          arguments: call.arguments,
        };
        const event: SessionEvent = {
          id: createEventId(),
          sessionId: sessionId as never,
          type: SessionEventType.PluginUiAppToolCallRequested,
          timestamp: new Date(),
          traceId: String(record.traceContext.traceId) as never,
          // 只进 live 投影、不落盘：seq 0 让 gateway 分配 transport 序号。
          sequenceNumber: 0,
          payload,
        };
        context.v4Gateway.ingest(sessionId, event);
      },
      ...(context.logger ? { logger: context.logger } : {}),
    });
    registries.set(context, registry);
  }
  return registry;
}

async function withScopeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpUiServerScopeError) {
      throw new ProtocolRequestError(error.code, error.message, { serverName: error.serverName });
    }
    throw error;
  }
}

export async function registerMcpUiAppTools(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiRegisterAppToolsResult> {
  const params = parseParams(zcodeMcpUiRegisterAppToolsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiRegisterAppTools",
  });
  return withScopeError(async () => {
    await assertMcpUiServerScope(createMcpUiSessionAccess(record, params), params);
    if (
      params.scopeId !== params.instance.token ||
      params.generation !== params.instance.generation
    )
      throw new Error("Invalid MCP App registration binding");
    return getMcpUiAppToolRegistry(context).register(params);
  });
}

export async function unregisterMcpUiAppTools(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiUnregisterAppToolsResult> {
  const params = parseParams(zcodeMcpUiUnregisterAppToolsParamsSchema, rawParams);
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  // 实例销毁时的 best effort 收尾：会话已关闭（登记已清空）不报错。
  if (!context.sessions.has(params.sessionId)) return { removed: 0 };
  return { removed: getMcpUiAppToolRegistry(context).unregister(params.sessionId, params) };
}

export async function claimMcpUiAppToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiAppToolAcceptedResult> {
  const params = parseParams(zcodeMcpUiClaimAppToolCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiClaimAppToolCall" });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  return { accepted: getMcpUiAppToolRegistry(context).claim(params) };
}

export async function resolveMcpUiAppToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiAppToolAcceptedResult> {
  const params = parseParams(zcodeMcpUiResolveAppToolCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiResolveAppToolCall",
  });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  return { accepted: getMcpUiAppToolRegistry(context).resolve(params) };
}

export function clearMcpUiAppToolsForSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): void {
  mcpUiInstances.closeSession(sessionId);
  registries.get(context)?.clearSession(sessionId);
}
