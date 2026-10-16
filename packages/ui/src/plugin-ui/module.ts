/**
 * plugin-ui 模块清单（architecture-governance managed 模块）。
 * ui 层：插件 UI 内联卡片、侧栏 tab、MCP Apps host 状态机接线、MessagePort 传输。
 * 层序 domain → app → adapters → components：domain 纯函数，app 管理生命周期，adapters 绑定外部能力，components 渲染。
 * 行为边界见本模块 CONTRACT.md。
 */
export const pluginUiModule = {
  id: "plugin-ui",
  requires: ["ui", "shared", "mcp-apps-protocol", "plugin-ui-bridge", "plugin-sandbox"],
  provides: ["plugin-ui-components"],
  publicEntrypoints: ["index.ts", "contract.ts", "hostPrimitives.ts"],
} as const;
