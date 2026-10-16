import type { RefObject } from "react";
import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import { SlidersHorizontalIcon } from "lucide-react";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ChatModeSwitchControl({
  compactIconOnly = false,
  disabled,
  disabledReason,
  intl,
  labelVisibilityClassName,
  modeOption,
  modeShortcutLabel,
  modeTriggerRef,
  onConfigValueChange,
  open,
  onOpenChange,
  restoreFocusSelector,
  selectedProvider,
}: {
  compactIconOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  labelVisibilityClassName?: string;
  modeOption: ZCodeConfigOption;
  modeShortcutLabel: string;
  modeTriggerRef: RefObject<HTMLSpanElement | null>;
  onConfigValueChange: (option: ZCodeConfigOption, value: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  restoreFocusSelector?: string | null;
  selectedProvider: ZCodeProvider;
}) {
  return (
    <ConfigSelect
      option={modeOption}
      onValueChange={(value) => onConfigValueChange(modeOption, value)}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      tooltipTitle={
        disabledReason ?? intl.formatMessage({ id: "chat.toolbar.mode.label" })
      }
      shortcutLabel={modeShortcutLabel}
      triggerRef={modeTriggerRef}
      triggerSize="default"
      triggerClassName={
        compactIconOnly
          ? // Bug 原因：窄 composer 隐藏 mode 文案后仍保留下拉箭头和横向 padding，
            // 触发器看起来像空白长按钮。窄态同步隐藏箭头并收成正方形，宽态恢复完整信息。
            "size-7 justify-center gap-0 rounded-lg p-0 text-ui-base @xl/composer:h-7 @xl/composer:w-fit @xl/composer:justify-between @xl/composer:gap-1 @xl/composer:pl-2 @xl/composer:pr-1.5"
          : "gap-1 rounded-lg pl-2 pr-1.5 text-ui-base"
      }
      indicatorClassName={
        compactIconOnly ? "hidden @xl/composer:block" : undefined
      }
      leadingIcon={SlidersHorizontalIcon}
      labelVisibilityClassName={labelVisibilityClassName}
      provider={selectedProvider}
      restoreFocusSelector={restoreFocusSelector}
    />
  );
}
