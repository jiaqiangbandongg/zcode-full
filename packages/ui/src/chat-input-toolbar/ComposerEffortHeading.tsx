import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { ControlShortcutBadge } from "@/ControlShortcutBadge.js";

export function ComposerEffortHeading({
  label,
  value,
  shortcut,
}: {
  label: string;
  value: string;
  shortcut?: string;
}) {
  return (
    <div className="mb-1 flex items-center gap-2 text-ui-base">
      <span className="text-ui-sm text-foreground-subtle">{label}</span>
      <span data-testid="composer-thought-value">
        <RollingToolbarLabel label={value} />
      </span>
      {/* 通用 Kbd 的 muted 颜色在当前主题未定义；与工具栏 Tooltip 复用同一键帽避免裸文字。 */}
      {shortcut ? (
        <ControlShortcutBadge className="ml-auto" data-testid="composer-effort-shortcut">
          {shortcut}
        </ControlShortcutBadge>
      ) : null}
    </div>
  );
}
