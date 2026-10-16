// ============================================================
// 工作流确认窗的「调整设置」：PermissionDialog 这一侧
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」「The options」；外观与键盘
// 见 docs/dynamic-workflow/presentation.md「The confirmation window」。
//
// 从 PermissionDialog.tsx 拆出：那边是所有确认窗共用的选项列表，这里只放工作流确认窗多出来的
// 三件事——改过的设置存在哪、哪些选项带着它走、Shift+Tab 从选项列表回到设置控件。

import { useCallback, useState } from "react";
import type { ZCodePermissionOption } from "@zcode/shared";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { getPermissionOptionDisplayKind } from "@/lib/permissionRequest.js";

/** 设置块的定位属性：Shift+Tab 从第一个选项回到这里。 */
export const WORKFLOW_PERMISSION_SETTINGS_SELECTOR = '[data-testid="workflow-permission-settings"]';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 窗里改过的设置与「所选模型不可用」。两份状态都记下它属于哪个 requestId，读时不匹配即视为没有：
 * 同一个对话框实例换请求时不靠 effect 归零——子组件按 requestId 重挂后会先回报新请求的状态，
 * 父组件的归零 effect 晚于它执行，会把新回报的「不可用」抹掉。
 */
export function usePermissionWorkflowSettings(requestId: string) {
  const [content, setContent] = useState<{
    requestId: string;
    value: WorkflowAskSettingsContent | undefined;
  } | null>(null);
  const [blocked, setBlocked] = useState<{ requestId: string; value: boolean } | null>(null);
  const onContentChange = useCallback(
    (value: WorkflowAskSettingsContent | undefined) => setContent({ requestId, value }),
    [requestId],
  );
  const onBlockedChange = useCallback(
    (value: boolean) => setBlocked({ requestId, value }),
    [requestId],
  );
  return {
    content: content?.requestId === requestId ? content.value : undefined,
    blocked: blocked?.requestId === requestId && blocked.value,
    onBlockedChange,
    onContentChange,
  };
}

/** 设置只随放行应答走：拒绝什么都不启动，Refine 的下一个窗带着模型改过的调用重来。 */
export function isWorkflowSettingsCarrier(option: ZCodePermissionOption): boolean {
  const kind = getPermissionOptionDisplayKind(option.kind);
  return kind === "allowOnce" || kind === "allowAlways";
}

/** 改过设置后，前两个选项说清这次应答带着什么走；其余描述不变。 */
export function workflowAdjustedOptionDescriptionId(messageId: string | null): string | null {
  switch (messageId) {
    case "chat.permission.allowOnce.description":
      return "chat.permission.workflow.allowOnce.adjusted";
    case "chat.permission.workflow.allowForSession.description":
      return "chat.permission.workflow.allowForSession.adjusted";
    default:
      return messageId;
  }
}

/**
 * Shift+Tab 在第一个选项上：离开选项列表，落到设置块的最后一个控件（倒着走的下一站），
 * 让焦点次序与阅读次序一致。块不在或没有可聚焦控件即返回 false，交回选项列表自己的循环。
 */
export function focusLastWorkflowSettingsControl(root: HTMLElement | null): boolean {
  const block = root?.querySelector<HTMLElement>(WORKFLOW_PERMISSION_SETTINGS_SELECTOR);
  const controls = block?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}
