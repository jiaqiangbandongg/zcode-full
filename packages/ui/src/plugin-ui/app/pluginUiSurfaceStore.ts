/**
 * 同一作用域同时只保留一个活 sandbox。
 * 键为 `buildPluginUiSurfaceKey(target, scope)`，统一隔离 workspace/session/plugin。
 * 侧栏打开时内联卡片显示占位；带 `display.ui.surface` 的工具结果据此判断面板是否已在本会话打开（R4 路由）。
 * 这里只记录"谁在渲染"，不持有任何沙箱状态。渲染进程内存，不持久化。
 */
export type PluginUiSurface = "inline" | "side-pane";

const surfaces = new Map<string, Map<symbol, PluginUiSurface>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function claimPluginUiSurface(key: string, surface: PluginUiSurface): () => void {
  const token = Symbol();
  const claims = surfaces.get(key) ?? new Map<symbol, PluginUiSurface>();
  const before = getPluginUiSurface(key);
  claims.set(token, surface);
  surfaces.set(key, claims);
  if (before !== getPluginUiSurface(key)) notify();
  return () => {
    const before = getPluginUiSurface(key);
    claims.delete(token);
    if (!claims.size && surfaces.get(key) === claims) surfaces.delete(key);
    if (before !== getPluginUiSurface(key)) notify();
  };
}

export function getPluginUiSurface(key: string): PluginUiSurface | null {
  const claims = surfaces.get(key);
  return claims?.size
    ? [...claims.values()].includes("side-pane")
      ? "side-pane"
      : "inline"
    : null;
}

export function subscribePluginUiSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiSurfacesForTest(): void {
  surfaces.clear();
  listeners.clear();
}
