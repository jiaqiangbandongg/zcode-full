import type { ConversationSharePopoverProps } from "@/conversation-share-interaction/contract.js";
import { useMemo } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 设置仍由 SessionPane 提供，锚点复用 workspace 顶栏入口，避免跨层传递第二份分享状态。 */
export function ConversationSharePopover({
  sessionId,
  open,
  publishing,
  selecting,
  onClose,
  onCancelSelection,
  children,
}: ConversationSharePopoverProps) {
  const { intl } = useZCodeIntl();
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          [...document.querySelectorAll<HTMLElement>("[data-share-session]")]
            .find((element) => element.dataset.shareSession === sessionId)
            ?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [sessionId],
  );
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!value && !publishing && !selecting) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={8}
        data-testid="conversation-share-popover"
        data-conversation-share-keep-open="settings"
        aria-label={intl.formatMessage({ id: "conversationShare.trigger" })}
        className="w-[22.5rem] max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) gap-0 p-0 [&>section]:min-h-0"
        style={
          selecting
            ? { maxHeight: "min(45dvh, var(--radix-popover-content-available-height))" }
            : undefined
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // 首次打开保持中性焦点，不让标题全选高亮抢走分享范围的注意力。
          if (event.target instanceof HTMLElement) event.target.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (publishing) return;
          if (selecting) onCancelSelection();
          else onClose();
        }}
        onFocusOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          const target = event.target;
          const inside =
            target instanceof Element &&
            target.closest(
              '[data-share-session], [data-conversation-share-left-navigation], [data-conversation-share-keep-open], [data-slot="popover-content"], [data-slot="select-content"]',
            );
          if (publishing || inside) {
            event.preventDefault();
            return;
          }
          if (selecting) {
            // 同一次点击还会产生 focusOutside，必须只结束范围事务，不能继续关闭设置。
            event.preventDefault();
            onCancelSelection();
          }
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
