import { join } from "node:path";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
} from "./official-plugin-definitions.js";

export type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

export function resolvePluginRuntimeFeatures(
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  const browserUsePlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePlugin && !cuaPlugin) {
    return {};
  }
  return {
    // Node REPL 已迁到真实 MCP server；这里仅启用 BrowserControlPort 注入，不再注册 core 裸 js*。
    ...(browserUsePlugin ? { browserUse: true } : {}),
    ...(browserUsePlugin
      ? { browserDocumentationRoot: join(browserUsePlugin.rootPath, "docs") }
      : {}),
    // CUA 与 Browser Use 共用同一个无状态 node_repl MCP server；这里只记录 CUA
    // SDK 是否需要由 bootstrap 注入 broker。不要设置 nodeRepl：那个字段会重新注册
    // 已迁移前的 core 裸 js 工具，导致 MCP 与 core 重复投影。
    ...(cuaPlugin ? { computerUse: true } : {}),
  };
}
