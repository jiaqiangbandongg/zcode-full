import type { BrowserViewCloseTabNotification } from "@zcode/shared";
import type { BrowserGuestExecutionContext } from "./browserGuestManager.js";

/** 构造 main→renderer 关闭通知所需的 owner scope 子集；完整 execution context 的其余字段与 renderer 无关。 */
export type BrowserCloseTabNotificationOwner = Pick<
  BrowserGuestExecutionContext,
  "workspaceKey" | "sessionId" | "remoteSessionId"
>;

/**
 * 把 main 侧 tab owner 折算成 renderer 能路由的关闭通知。
 *
 * 旧 payload 只有 tabId，renderer 只能在“当前活跃 workspace”的 side pane 状态里查找；
 * 用户已切到别的 workspace 时通知被静默丢弃，原 workspace 的持久化状态里留下关不掉的幽灵 tab。
 * 带上 owner scope 后 renderer 能直接定位到对应 workspace 的 side pane 内存删除该 tab。
 *
 * 抽成纯函数是为了让字段映射可被单测覆盖：内联在 `index.ts` 的 manager 构造回调里时，
 * Electron 入口不进单测、`closeTabFromRenderer` 又走 `notifyRenderer=false` 不经过这里，
 * 整条 Agent close 通知链路的字段拼装就没有任何测试防护。
 *
 * owner 允许缺省：recovery-orphan 等内部路径只有 tabId，renderer 此时退回“仅当前 workspace”语义。
 */
export function buildBrowserViewCloseTabNotification(
  tabId: string,
  owner?: BrowserCloseTabNotificationOwner,
): BrowserViewCloseTabNotification {
  if (!owner) return { tabId };
  return {
    tabId,
    workspaceKey: owner.workspaceKey,
    sessionId: owner.sessionId,
    // remote workspace 才有 remoteSessionId；本地 workspace 必须让该字段缺席而不是显式 undefined，
    // renderer 侧按 `payload.remoteSessionId` 是否存在区分作用域。
    ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
  };
}
