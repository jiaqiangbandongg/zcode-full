import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildPluginUiSurfaceKey, PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX } from "../contract.js";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";
import type { UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPage } from "./pluginUiManagedPage.js";
import { acquirePluginUiPage, pluginUiPages, subscribePage } from "./pluginUiPageRegistry.js";
export type { UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
function pageIdentity(input: UsePluginUiHostInput): { key: string; input: UsePluginUiHostInput } {
  const scope = resolvePluginUiLogicalScope(input.presentation, input.scope.scope);
  const key = buildPluginUiSurfaceKey({ ...input.scope, ...input.presentation }, scope);
  return { key, input: { ...input, scope: { ...input.scope, scope } } };
}

/** 锚点订阅唯一窗口 owner；切位置、重渲染和卡片卸载不销毁页面。 */
export function usePluginUiHost(input: UsePluginUiHostInput): UsePluginUiHostResult {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const local =
    !input.scope.remoteSessionId && !isRemoteWorkspaceIdentity(input.scope.workspaceIdentity ?? "");
  const identified = pageIdentity(input);
  const key = identified.key;
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const empty = useMemo<UsePluginUiHostResult>(
    () => ({
      pageKey: key,
      supported: Boolean(local && platform?.pluginSandbox && services?.pluginUiBridgeService),
      phase: failure?.key === key ? "error" : "idle",
      handle: null,
      height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
      error: failure?.key === key ? failure.error : null,
      appCapabilities: undefined,
      reload: () => setFailure(null),
    }),
    [key, platform, services, failure, local],
  );
  // 创建只发生在 effect；外部 store 的快照身份稳定，不在 render 写入 controller。
  const [subscribe, read] = useMemo(
    () =>
      [
        (listener: () => void) => subscribePage(key, listener),
        () => pluginUiPages.get(key)?.snapshot() ?? empty,
      ] as const,
    [key, empty],
  );
  const result = useSyncExternalStore(subscribe, read, () => empty);
  useEffect(() => {
    if (
      !local ||
      !platform?.pluginSandbox ||
      !services?.pluginUiBridgeService ||
      input.enabled === false
    )
      return;
    if (failure?.key === key) return;
    let current = true;
    void acquirePluginUiPage(key, () => createPage(key, identified.input, platform, services)).then(
      (page) => {
        if (current) page.update(identified.input);
      },
      (error) => {
        if (current) setFailure({ key, error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  });
  return result;
}
