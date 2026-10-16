import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import type { PluginSandboxTransportPort } from "@zcode/shared/mcp-apps";

/**
 * 宿主 renderer 侧的 MCP `Transport`：一条 MessagePort（main 建的 channel 的 port2）上跑原始 JSON-RPC，
 * 另一端是 relay shell → 插件 iframe 里的官方 `App`（或手写 JSON-RPC）。不解析业务，只做 JSON-RPC 帧的最小形状检查。
 */
export function createPluginUiMessagePortTransport(port: PluginSandboxTransportPort): Transport {
  let closed = false;
  const transport: Transport = {
    async start() {
      port.onmessage = (event) => {
        if (closed) return;
        const data = event.data;
        if (
          typeof data !== "object" ||
          data === null ||
          (data as { jsonrpc?: unknown }).jsonrpc !== "2.0"
        ) {
          transport.onerror?.(new Error("plugin-ui: non JSON-RPC frame on sandbox port"));
          return;
        }
        transport.onmessage?.(data as JSONRPCMessage);
      };
      port.start?.();
    },
    async send(message) {
      if (closed) throw new Error("plugin-ui: sandbox transport closed");
      port.postMessage(message);
    },
    async close() {
      if (closed) return;
      closed = true;
      port.onmessage = null;
      port.close();
      transport.onclose?.();
    },
  };
  return transport;
}
