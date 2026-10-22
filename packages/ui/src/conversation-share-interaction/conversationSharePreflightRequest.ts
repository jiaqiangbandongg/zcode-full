import type { ConversationSharePreflightRequest } from "@/conversation-share-interaction/contract.js";

/**
 * 预检 effect 的一次请求代际。清理时不仅撤销 debounce，也作废已经发出的 RPC 回调。
 * 否则关闭后同 scope 重开或快速改选，旧成功/失败会覆盖新缓存；scope key 无法区分这些代际。
 */
export function scheduleConversationSharePreflightRequest<T>(
  options: ConversationSharePreflightRequest<T>,
): () => void {
  let active = true;
  const timer = setTimeout(() => {
    void Promise.resolve()
      .then(options.request)
      .then(
        (result) => {
          if (active) options.onResolved(result);
        },
        (error: unknown) => {
          if (active) options.onRejected(error);
        },
      )
      .catch((error: unknown) => {
        if (active) options.onError(error);
      });
  }, 150);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
