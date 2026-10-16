/**
 * mcp-apps-protocol 模块清单（architecture-governance managed 模块）。
 * 纯 domain：MCP Apps 的 ZCode 扩展常量、`_meta` 归一化、`display.ui` schema 与沙箱契约类型，零 IO。
 * 页面 ↔ 宿主的线协议由官方 `@modelcontextprotocol/ext-apps` 承担，本模块不再持有状态机。
 */
export const mcpAppsProtocolModule = {
  id: "mcp-apps-protocol",
  requires: [],
  provides: ["mcp-apps-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
