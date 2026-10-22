import { useEffect, useState, useReducer } from "react";
import type { PluginUiSurfaceEntry } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  isPluginManagementChangeRelevant,
  subscribePluginManagementChanges,
} from "@/store/pluginManagementStoreLoading.js";

export interface UsePluginUiSurfacesInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** false 时不拉取（无会话 / 平台不支持），返回空数组。 */
  enabled?: boolean;
}

/**
 * 工作区级面板入口（）：经桥读 `plugins/listUiSurfaces`。
 * 只订阅当前插件管理命令的成功变更；旧 pluginStore 不接收真实安装和启停结果。
 */
export function usePluginUiSurfaces(input: UsePluginUiSurfacesInput): PluginUiSurfaceEntry[] {
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const [pluginRevision, refresh] = useReducer((value: number) => value + 1, 0);
  const enabled = input.enabled !== false && Boolean(bridge);
  useEffect(() => {
    if (!enabled) return;
    return subscribePluginManagementChanges((change) => {
      if (
        isPluginManagementChangeRelevant(
          {
            workspacePath: input.workspacePath,
            workspaceIdentity: input.workspaceIdentity?.trim() || null,
            authorityKey: null,
            configScope: null,
          },
          change,
        )
      )
        refresh();
    });
  }, [enabled, input.workspacePath, input.workspaceIdentity]);
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
  }, [bridge, enabled, input.workspaceIdentity, input.workspacePath, pluginRevision]);

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
