/**
 * 插件页面 widgetState 的唯一 owner。
 * 键为 `buildPluginUiSurfaceKey(target, scope)`：workspaceKey + sessionId + pluginId + server + resource + scopeId，
 * 与 pluginUiSurfaceStore 同一套隔离。页面 `ui/set-widget-state` 同步写这里；`usePluginUiHost` 在
 * 创建 AppBridge 时从这里取初值，所以会话内折叠再展开 / 关闭重开面板都能恢复。
 * renderer 内存，不持久化：进程重启后为空；插件的业务数据应存在自己的服务端。
 * 4a-0 起不再经 CLI 命令写会话存储，也没有"模型可见"语义——要给模型信息走 updateModelContext。
 */
const states = new Map<string, unknown>();

/** 未写入过返回 undefined；页面写入的 null 原样保留（区分"未加载"与"已清空"）。 */
export function getPluginUiWidgetState(key: string): unknown {
  return states.get(key);
}

export function setPluginUiWidgetState(key: string, widgetState: unknown): void {
  states.set(key, widgetState);
}

export function clearPluginUiWidgetState(key: string): void {
  states.delete(key);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiWidgetStateForTest(): void {
  states.clear();
}
