import {
  EMPTY_PLUGIN_UI_SURFACE_FEED,
  mergePluginUiSurfaceFeed,
  type PluginUiSurfaceFeed,
} from "../domain/pluginUiToolFeed.js";

/**
 * 面板投喂快照的 owner（renderer 内存，不持久化）。键为 `buildPluginUiSurfaceKey(target, surfaceScope)`，
 * 与 pluginUiSurfaceStore / pluginUiWidgetStateStore 同一套隔离。面板 model 从投影窗口归约出快照后合并到这里，
 * 关闭再打开面板、投影窗口裁掉旧行时都还能拿到"最后一次成功结果"。只按 rowId 单调合并，不接受回退。
 */
const feeds = new Map<string, PluginUiSurfaceFeed>();
const listeners = new Set<() => void>();

export function getPluginUiSurfaceFeed(key: string): PluginUiSurfaceFeed {
  return feeds.get(key) ?? EMPTY_PLUGIN_UI_SURFACE_FEED;
}

/** 合并后返回存储的快照；无变化时返回原引用且不通知。 */
export function offerPluginUiSurfaceFeed(
  key: string,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const current = getPluginUiSurfaceFeed(key);
  const next = mergePluginUiSurfaceFeed(current, candidate);
  if (next === current) return current;
  feeds.set(key, next);
  for (const listener of listeners) listener();
  return next;
}

export function subscribePluginUiSurfaceFeeds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiSurfaceFeedsForTest(): void {
  feeds.clear();
  listeners.clear();
}

export function clearPluginUiSurfaceFeed(key: string): void {
  feeds.delete(key);
}
