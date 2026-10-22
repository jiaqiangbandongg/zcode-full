import type { ReactNode } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import type { ShortcutKeySearch } from "@/settings/useShortcutKeySearch.js";

interface ShortcutSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  keySearch: ShortcutKeySearch;
  /** 武装态与行内录制互斥：激活按键搜索前先取消进行中的行内录制。 */
  onArmKeySearch: () => void;
  /** 搜索条右侧操作区（「全部恢复默认」按钮）。 */
  actions?: ReactNode;
}

/** 快捷键设置页搜索条：文本搜索框 + VSCode 式「按组合键搜索」按钮。 */
export function ShortcutSearchBar({
  query,
  onQueryChange,
  keySearch,
  onArmKeySearch,
  actions,
}: ShortcutSearchBarProps) {
  const { intl } = useZCodeIntl();
  // VSCode 同款展示：捕获的组合键作为输入框文本从左侧显示（替代文本搜索词，
  // 文本过滤条件仍在内部生效，× 清除后回到纯文本搜索）。
  const keyLabel =
    keySearch.binding !== null ? formatShortcutBindingLabel(keySearch.binding) : null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      {actions}
      <SettingsSearchInput
        containerClassName="w-full min-w-0 sm:ml-auto sm:w-64"
        className={keyLabel !== null ? "font-mono text-brand" : undefined}
        placeholder={intl.formatMessage({
          id: keySearch.armed
            ? "settings.shortcuts.keySearchPlaceholder"
            : "settings.shortcuts.searchPlaceholder",
        })}
        value={keyLabel ?? query}
        onChange={(e) => onQueryChange(e.target.value)}
        // 按键过滤继续与原文本条件 AND；展示组合键时保持只读，避免改变搜索语义。
        readOnly={keySearch.armed || keyLabel !== null}
        data-testid="settings-shortcut-search-input"
        clearLabel={intl.formatMessage({
          id: keyLabel !== null ? "settings.shortcuts.keySearchClearAria" : "settings.search.clear",
        })}
        clearTestId={
          keyLabel !== null
            ? "settings-shortcut-key-search-clear"
            : "settings-shortcut-search-clear"
        }
        onClear={
          keySearch.armed
            ? undefined
            : keyLabel !== null
              ? keySearch.clear
              : () => onQueryChange("")
        }
        trailingAction={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchAria" })}
            aria-pressed={keySearch.armed}
            data-testid="settings-shortcut-key-search"
            className={`rounded-full ${keySearch.armed ? "text-brand" : "text-foreground-subtle"}`}
            onClick={() => {
              if (!keySearch.armed) onArmKeySearch();
              keySearch.toggle();
            }}
          >
            <Keyboard className="size-4" aria-hidden="true" />
          </Button>
        }
      />
    </div>
  );
}
