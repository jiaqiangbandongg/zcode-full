import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 读取插件根目录 .zcode-plugin/plugin.json 的 name。
 *
 * 原因：插件名决定 MCP 服务身份与 ui://<name>/ 资源地址。内置插件包目录名带 -plugin 后缀
 * （如 pdf-plugin），不能再从目录名推导，否则面板资源地址与 manifest 声明的 resourceUri 不一致。
 */
export async function readPluginName(pluginRoot) {
  const manifestPath = join(pluginRoot, ".zcode-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    throw new Error(`${manifestPath}: 缺少插件 name`);
  return manifest.name;
}
