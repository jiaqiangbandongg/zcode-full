import { dispatchPluginUiResourceDelta } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { useEffect } from "react";

/**
 * 把一个会话投影 store 的 live-only 增量接到资源通知路由表。
 * 同一 store 可能被 SessionPane 与多个侧栏 tab 同时持有，按 store 引用计数只挂一个监听，避免重复投递。
 */
const feeds = new Map<ConversationProjectionStore, { count: number; off: () => void }>();

export function attachPluginUiResourceDeltaFeed(
  store: ConversationProjectionStore,
  scope: PluginUiSessionScope,
): () => void {
  let entry = feeds.get(store);
  if (!entry) {
    const sessionKey = buildPluginUiSessionKey(scope);
    const off = store.onLiveDeltas((deltas) => {
      for (const delta of deltas) {
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        ) {
          dispatchPluginUiResourceDelta(sessionKey, delta);
        }
      }
    });
    entry = { count: 0, off };
    feeds.set(store, entry);
  }
  const active = entry;
  active.count += 1;
  return () => {
    active.count -= 1;
    if (active.count === 0 && feeds.get(store) === active) {
      active.off();
      feeds.delete(store);
    }
  };
}

export function usePluginUiResourceDeltaFeed(
  store: ConversationProjectionStore | null | undefined,
  scope: PluginUiSessionScope | null,
): void {
  const sessionKey = scope ? buildPluginUiSessionKey(scope) : null;
  useEffect(() => {
    if (!store || !scope) return;
    return attachPluginUiResourceDeltaFeed(store, scope);
    // scope 按会话键比较（SessionPane 每次渲染可能新建对象），不把对象本身放进依赖。
  }, [store, sessionKey]);
}
