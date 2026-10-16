import type {
  McpUiCallToolResult,
  McpUiReadResourceResult,
  McpUiSessionAccess,
} from "./contract.js";
import { McpUiNotSupportedError } from "./resourceContract.js";

/** 一个只认识单个 server 的内存 session 视图，供契约测试与示例使用。 */
export function createExampleSessionAccess(): McpUiSessionAccess {
  const html: McpUiReadResourceResult = {
    contents: [
      {
        uri: "ui://example-plugin/widget.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><p>widget</p>",
      },
    ],
  };
  const echo: McpUiCallToolResult = { content: [{ type: "text", text: "pong" }] };
  return {
    hasMcpServer: async (serverName) => serverName === "plugin:example-plugin:widget",
    // H03：echo_app_only 只给页面调；ping 两者可见；其它工具不存在。
    getToolVisibility: async (_serverName, toolName) =>
      toolName === "echo_app_only" ? ["app"] : toolName === "ping" ? ["model", "app"] : null,
    readResource: async () => html,
    callTool: async () => echo,
    readResourceForUi: async () => html,
    // 4b-2：示例 server 只有一份静态资源，不支持订阅。
    listResourcesForUi: async () => ({
      resources: [
        {
          uri: "ui://example-plugin/widget.html",
          name: "widget",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    }),
    listResourceTemplatesForUi: async () => ({ resourceTemplates: [] }),
    subscribeResourceForUi: async () => {
      throw new McpUiNotSupportedError("plugin:example-plugin:widget", "resources/subscribe");
    },
    unsubscribeResourceForUi: async () => {},
  };
}
