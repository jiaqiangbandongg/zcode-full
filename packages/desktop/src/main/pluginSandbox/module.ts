/**
 * plugin-sandbox 模块清单（architecture-governance managed 模块）。
 * Electron 适配层：`zcode-sandbox://` scheme、沙箱注册表、CSP 生成、guest 策略、用户手势代理、
 * Host 登记适配器、宿主/guest preload、受信 relay shell 与页面侧 window.zcode 别名（官方 App 上的薄封装）。
 */
export const pluginSandboxModule = {
  id: "plugin-sandbox",
  requires: ["desktop", "shared", "mcp-apps-protocol", "gen-ui-protocol"],
  provides: ["plugin-sandbox-registry", "plugin-sandbox-platform"],
  publicEntrypoints: ["index.ts", "contract.ts", "aliasRuntime.ts", "aliasApi.ts"],
} as const;
