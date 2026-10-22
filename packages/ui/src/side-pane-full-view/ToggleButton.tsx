import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { TID_SIDE_PANE_FULL_VIEW_TOGGLE } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Side Pane 右上角「进入 / 退出完整视图」按钮（spec：docs/ui/side-pane-full-view.md）。 */
export function SidePaneFullViewToggleButton({
  active,
  onToggle,
  shortcutLabel,
}: {
  active: boolean;
  onToggle: () => void;
  shortcutLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({
    id: active ? "sidePane.fullView.exit" : "sidePane.fullView.enter",
  });
  const Icon = active ? Minimize2Icon : Maximize2Icon;
  return (
    <ControlHintTooltip title={label} side="bottom" align="end" shortcut={shortcutLabel}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SIDE_PANE_FULL_VIEW_TOGGLE}
        data-active={active ? "true" : "false"}
        aria-label={label}
        aria-pressed={active}
        className={cn("text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]")}
        onClick={onToggle}
      >
        <Icon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
