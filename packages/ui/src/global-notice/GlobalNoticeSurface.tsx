import { useEffect, useState, useSyncExternalStore } from "react";
import {
  browserGlobalNoticeStore,
  type GlobalNoticeStore,
} from "@/global-notice/globalNoticeStore.js";
import { HighspeedShareNoticeCard } from "@/highspeed/HighspeedShareNoticeCard.js";

const subscribeNoop = () => () => undefined;
const getNullSnapshot = () => null;

export function GlobalNoticeSurface({
  store = browserGlobalNoticeStore,
}: {
  store?: GlobalNoticeStore | null;
} = {}) {
  const [, refreshAtExpiry] = useState(0);
  const notice = useSyncExternalStore(
    store?.subscribe ?? subscribeNoop,
    store ? () => store.getVisible() : getNullSnapshot,
    getNullSnapshot,
  );

  useEffect(() => {
    if (notice?.expiresAt === undefined) return;
    const delayMs = Math.max(0, notice.expiresAt - Date.now()) + 20;
    // Bug 根因：expiresAt 只在 store 事件时重算，页面持续打开会让过期卡一直留在界面上。
    const timer = window.setTimeout(() => refreshAtExpiry((revision) => revision + 1), delayMs);
    return () => window.clearTimeout(timer);
  }, [notice?.expiresAt, notice?.noticeId]);

  if (!notice) return null;

  if (notice.type === "highspeed-share" && notice.schemaVersion === 1) {
    return (
      <HighspeedShareNoticeCard
        notice={notice}
        onDismiss={() => store?.dismiss(notice.noticeId)}
      />
    );
  }

  // 未注册的通知类型由 surface 安全忽略，避免未知 payload 破坏全局侧栏。
  return null;
}
