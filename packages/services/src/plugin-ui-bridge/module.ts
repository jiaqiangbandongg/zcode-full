/**
 * plugin-ui-bridge 模块清单（architecture-governance managed 模块）。
 * host 侧服务：读取并校验插件 `ui://` 资源、向 main 登记沙箱、代理 UI 发起的工具调用，
 * 以及 App-Provided Tools 的登记 / 认领 / 回传通道（appToolsContract.ts）。
 */
export const pluginUiBridgeModule = {
  id: "plugin-ui-bridge",
  requires: ["services", "shared", "mcp-apps-protocol"],
  provides: ["plugin-ui-bridge-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "appToolsContract.ts", "samplingContract.ts"],
} as const;
