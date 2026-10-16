import { useEffect, useState } from "react";
import type { PluginUiSurfaceEntry } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { usePluginStore } from "@/store/pluginStore.js";

export interface UsePluginUiSurfacesInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** false 时不拉取（无会话 / 平台不支持），返回空数组。 */
  enabled?: boolean;
}

/**
 * 工作区级面板入口（）：经桥读 `plugins/listUiSurfaces`。
 * 刷新信号复用插件设置页的 store：`installedPlugins` 的 id+enabled 指纹变化（安装 / 卸载 / 启停）即重新拉取；
 * 不再另起事件通道，也不缓存跨 workspace。
 */
export function usePluginUiSurfaces(input: UsePluginUiSurfacesInput): PluginUiSurfaceEntry[] {
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const pluginFingerprint = usePluginStore((state) =>
    state.installedPlugins.map((plugin) => `${plugin.id}:${plugin.enabled ? 1 : 0}`).join("|"),
  );
  const enabled = input.enabled !== false && Boolean(bridge);
  const [surfaces, setSurfaces] = useState<PluginUiSurfaceEntry[]>([]);

  useEffect(() => {
    if (!enabled || !bridge) {
      setSurfaces([]);
      return;
    }
    let cancelled = false;
    void bridge
      .listSurfaces({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      })
      .then((next) => {
        if (!cancelled) setSurfaces(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[plugin-ui] listSurfaces failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        setSurfaces([]);
      });
    return () => {
      cancelled = true;
    };
    // pluginFingerprint 只作刷新信号。
  }, [bridge, enabled, input.workspaceIdentity, input.workspacePath, pluginFingerprint]);

  return surfaces;
}

/** 清单 title 可为 locale → string；按 locale、语言前缀、en、任一值顺序取。 */
export function resolvePluginUiSurfaceTitle(
  title: PluginUiSurfaceEntry["title"],
  locale: string,
): string {
  if (typeof title === "string") return title;
  const language = locale.split("-")[0] ?? locale;
  return (
    title[locale] ??
    title[language] ??
    Object.entries(title).find(([key]) =>
      key.toLowerCase().startsWith(language.toLowerCase()),
    )?.[1] ??
    title.en ??
    Object.values(title)[0] ??
    ""
  );
}
