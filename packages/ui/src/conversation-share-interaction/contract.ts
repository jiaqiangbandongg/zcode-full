import type { ReactNode } from "react";
import type { ConversationSharePreflightResult } from "@zcode/services";
export type {
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
  ConversationShareFailureIssue,
} from "@zcode/services";

/** UI 状态只用于展示，预检结果与缓存的唯一 owner 是 SessionPane。 */
export type ConversationSharePreflightState =
  | { status: "idle" | "checking" }
  | ({ status: "ready" | "stale" } & ConversationSharePreflightResult);

export interface ConversationSharePreflightStatusProps {
  /**
   * 整轮取消选择。只接受 productTurnId：turnOrdinal 是 service 按全部 turnHeader
   * 编号的展示序号，用它反查 UI 的 per-query 列表会取消到别的轮次。
   */
  onDeselectTurn?: (productTurnId: string) => void;
  /** 传输类阻断（网络/RPC 抖动）没有可操作对象，只能整体重新预检。 */
  onRetryPreflight?: () => void;
  preflight?: ConversationSharePreflightState;
}

/** 用户关闭/取消由外部 owner 执行；发布期间浮窗不接受关闭。 */
export interface ConversationSharePopoverProps {
  sessionId: string;
  open: boolean;
  publishing: boolean;
  selecting: boolean;
  onClose: () => void;
  onCancelSelection: () => void;
  children: ReactNode;
}

/** 一次请求代际。取消后包括已发出的异步结果在内，所有回调都不得提交状态。 */
export interface ConversationSharePreflightRequest<T> {
  request: () => Promise<T>;
  onResolved: (result: T) => void;
  onRejected: (error: unknown) => void;
  onError: (error: unknown) => void;
}
