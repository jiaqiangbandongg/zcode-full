import type { McpToolUiDescriptor, PluginSandboxHandle } from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  PLUGIN_SANDBOX_PORT_NAME,
  buildMcpAppsClientCapabilities,
  buildMcpAppsCspExperimentalCapability,
} from "./contract.js";

/** 一个带 UI 资源的工具 `_meta` 归一化后应得到的描述。 */
export const exampleToolUiDescriptor: McpToolUiDescriptor = {
  resourceUri: "ui://example-plugin/widget.html",
  visibility: ["model", "app"],
  preferredDisplayMode: "inline",
  csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] },
  prefersBorder: true,
};

/** main 登记成功后返回给 renderer 的句柄；partition 按 server 身份派生，同一 server 的页面共享。 */
export const exampleSandboxHandle: PluginSandboxHandle = {
  instance: {
    runtimeId: "test-agent",
    generation: 1,
    token: "test-token",
    appIdentity: "a".repeat(64),
  },
  sandboxId: "sb-01",
  initId: 1,
  shellUrl: "zcode-sandbox://shell-sb-01/",
  partition: "persist:plugin-sandbox-v1-0123456789abcdef",
  // 句柄能带的全部资源级字段都写上：contract.test 用它过 host 的 strict 回包 schema，字段漏同步会在这里失败。
  resourceMeta: {
    prefersBorder: true,
    heightHint: 320,
    minFrameHeight: 120,
    showInline: false,
    permissions: ["clipboardWrite"],
  },
};

/** agent 对 MCP server `initialize` 时宣告的 ui 扩展能力。 */
export const exampleClientCapabilities = buildMcpAppsClientCapabilities();
/** 宿主在 hostCapabilities.experimental 里宣告的 CSP 放宽键。 */
export const exampleCspExperimental = buildMcpAppsCspExperimentalCapability();
/** 资源级 `_meta` 里声明放宽的写法。 */
export const exampleResourceMetaWithRelaxations = {
  ui: { csp: { connectDomains: ["https://api.example.com"] } },
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true },
};
export const exampleSetWidgetStateMethod = MCP_APPS_SET_WIDGET_STATE_METHOD;
export const examplePortName = PLUGIN_SANDBOX_PORT_NAME;
