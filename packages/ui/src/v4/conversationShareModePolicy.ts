export function resolveConversationSelectionTooltipEnabled({
  selectionActionsEnabled,
  partialShareActive,
}: {
  selectionActionsEnabled: boolean;
  partialShareActive: boolean;
}): boolean {
  // 分享浮窗打开期间关闭全局 Selection 工具条，避免跨功能交互抢占焦点。
  return selectionActionsEnabled && !partialShareActive;
}
