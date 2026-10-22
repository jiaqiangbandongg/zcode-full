import { MessageCircleIcon } from "lucide-react";
import { TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { TabsTrigger } from "@/components/ui/tabs.js";

/** 完整视图下 tab 栏里固定在第一位的对话 tab；Radix value 用保留值，不进入面板 tab registry。 */
export const SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE = "__side-pane-full-view-conversation__";

export function SidePaneFullViewConversationTab({
  title,
  isActive,
}: {
  title: string;
  isActive: boolean;
}) {
  return (
    <TabsTrigger value={SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE} asChild>
      <div
        title={title}
        data-testid={TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        className={cn(
          "group relative inline-flex shrink-0 items-center gap-1.5",
          "!h-7 max-w-60 justify-start overflow-hidden rounded-lg border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle hover:text-foreground",
          !isActive && "hover:!bg-hover",
          "data-active:!bg-selected data-active:text-foreground",
          "cursor-default",
          // 修复原因：tab 栏是窗口拖拽区，面板 tab 靠 data-side-pane-tab-id 排除；对话 tab 漏了排除，
          // 真实鼠标点击被 Electron 当成拖动窗口（CDP 合成点击绕过拖拽区，E2E 曾测不出来）。
          "[app-region:no-drag]",
        )}
      >
        <MessageCircleIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{title}</span>
      </div>
    </TabsTrigger>
  );
}
