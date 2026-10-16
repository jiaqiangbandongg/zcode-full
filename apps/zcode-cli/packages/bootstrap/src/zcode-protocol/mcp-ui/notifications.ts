import {
  SessionEventType,
  createEventId,
  type McpServerNotification,
  type PluginUiResourceSubscriberRef,
  type SessionEvent,
} from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";
import { parseMcpUiSubscriberKey } from "./contract.js";
import { mcpUiInstances } from "./instances.js";

/**
 * MCP server 通知 → 会话。
 * - resources/updated / list_changed：按 subscriberKey 拆成各会话一条 live-only 事件（v4Gateway.ingest，seq 0），
 *   没有订阅者直接丢弃；插件归属从会话冻结 catalog 反查（server → pluginId）。
 * - notifications/message：进 agent 日志 `mcp:<server>`（error 及以上 → error，warning → warn，其余 debug）。
 * - tools/list_changed：adapter 已标 stale，这里只记 debug（回合边界重拉，A7）。
 */
export function routeMcpServerNotification(
  context: ZCodeProtocolAgentServerContext,
  notification: McpServerNotification,
): void {
  switch (notification.kind) {
    case "loggingMessage": {
      const logger = context.logger?.child?.({ module: `mcp:${notification.serverName}` });
      const fields = {
        event: "mcp.server.log",
        mcpServerName: notification.serverName,
        ...(notification.logger ? { mcpLogger: notification.logger } : {}),
        data: notification.data,
      };
      const level = notification.level;
      if (["error", "critical", "alert", "emergency"].includes(level)) {
        logger?.error("MCP server log", undefined, fields);
      } else if (level === "warning") {
        logger?.warn("MCP server log", fields);
      } else {
        logger?.debug("MCP server log", fields);
      }
      return;
    }
    case "toolListChanged":
      context.logger?.debug("MCP tool list changed; refresh at next turn", {
        event: "mcp.tools.list_changed",
        mcpServerName: notification.serverName,
      });
      return;
    case "resourceUpdated":
    case "resourceListChanged": {
      const bySession = new Map<string, PluginUiResourceSubscriberRef[]>();
      for (const key of notification.subscribers) {
        const parsed = parseMcpUiSubscriberKey(key);
        if (!parsed) continue;
        const active = mcpUiInstances.find(parsed.scopeId);
        const record = context.sessions.get(parsed.sessionId);
        if (!active || !record || active.lease.generation !== parsed.generation) continue;
        try {
          mcpUiInstances.validate(
            active.lease,
            {
              sessionId: parsed.sessionId,
              pluginId: active.binding.pluginId,
              serverName: notification.serverName,
            },
            record.app.getMcpAppConnectionSnapshot(notification.serverName),
          );
        } catch {
          continue;
        }
        const list = bySession.get(parsed.sessionId) ?? [];
        list.push({
          scopeId: parsed.scopeId,
          generation: parsed.generation,
          instance: active.lease,
        });
        bySession.set(parsed.sessionId, list);
      }
      if (bySession.size === 0) return;
      const gateway = context.v4Gateway;
      if (!gateway) return;
      for (const [sessionId, subscribers] of bySession) {
        const record = context.sessions.get(sessionId);
        if (!record) continue;
        const pluginId =
          record.app
            .getPluginReferenceCatalog()
            .plugins.find((plugin) => plugin.mcpServerNames.includes(notification.serverName))
            ?.pluginId ?? "";
        const base = { pluginId, serverName: notification.serverName, subscribers };
        const event: SessionEvent = {
          id: createEventId(),
          sessionId: sessionId as never,
          type:
            notification.kind === "resourceUpdated"
              ? SessionEventType.PluginUiResourceUpdated
              : SessionEventType.PluginUiResourceListChanged,
          timestamp: new Date(),
          traceId: String(record.traceContext.traceId) as never,
          // 只进 live 投影、不落盘：seq 置 0 让 gateway 分配 transport 序号（与 elicitation 合成事件同法）。
          sequenceNumber: 0,
          payload: (notification.kind === "resourceUpdated"
            ? { ...base, uri: notification.uri }
            : base) as never,
        };
        gateway.ingest(sessionId, event);
      }
      return;
    }
  }
}
