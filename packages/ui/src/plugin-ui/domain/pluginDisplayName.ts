/**
 * 插件 id 形如 `<name>@<marketplace>`；对用户只显示 name 部分。纯函数，供来源标签与确认框共用。
 */
export function formatPluginDisplayName(pluginId: string): string {
  const at = pluginId.indexOf("@");
  const name = at > 0 ? pluginId.slice(0, at) : pluginId;
  return name.trim() || pluginId;
}
