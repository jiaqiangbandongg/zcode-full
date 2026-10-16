import type { IPluginUiBridgeService } from "./contract.js";

/** UI 侧典型用法：先准备沙箱拿句柄，再把句柄交给 webview 挂载；面板作用域用 `surface:<id>`。 */
export async function examplePrepareAndMount(bridge: IPluginUiBridgeService) {
  const handle = await bridge.prepareSandbox({
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    scopeId: "tool:call_1",
    resourceUri: "ui://example-plugin/widget.html",
    ownerWebContentsId: 1,
  });
  return { src: handle.shellUrl, partition: handle.partition, initId: handle.initId };
}

/** 页面 `resources/read` 经桥读取同插件服务器的二进制资源；结果与 MCP 同形。 */
export async function exampleReadBlob(bridge: IPluginUiBridgeService) {
  const result = await bridge.readResource({
    instance: {
      runtimeId: "test-agent",
      generation: 1,
      token: "test-token",
      appIdentity: "a".repeat(64),
    },
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    uri: "ui://example-plugin/model.glb",
  });
  return result.contents[0]?.blob ?? null;
}

/** sampling 绑定已有页面身份，历史由 App 提交，结果只返回 App。 */
export function exampleSample(
  service: import("./samplingContract.js").IPluginUiSamplingService,
  scope: import("./contract.js").PluginUiPluginScope,
) {
  return service.sample({
    ...scope,
    operationId: "sample-1",
    request: {
      messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
      maxTokens: 128,
    },
  });
}
