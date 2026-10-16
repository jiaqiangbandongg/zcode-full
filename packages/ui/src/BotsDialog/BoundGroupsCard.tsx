import type { BotConfig } from "@zcode/shared";
import { useBotBoundGroups, type BoundGroupRow } from "@/hooks/useBotBoundGroups.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

export function BoundGroupsList({
  rows,
  disabled,
  saving,
  onToggle,
}: {
  rows: BoundGroupRow[];
  disabled: boolean;
  saving: string | null;
  onToggle: (chatId: string, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="divide-y divide-border" data-testid="bot-bound-groups">
      {rows.map((row) => (
        <div
          key={row.chatId}
          className="flex min-w-0 items-center gap-3 px-4 py-3"
          data-group-id={row.chatId}
        >
          <span
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            title={row.name}
          >
            {row.name}
          </span>
          <span className="shrink-0 whitespace-nowrap text-ui-sm text-foreground-subtle">
            {/* 当前格式化器只替换简单占位符，单复数通过文案 key 选择。 */}
            {intl.formatMessage(
              { id: row.topicCount === 1 ? "bots.boundGroups.countOne" : "bots.boundGroups.count" },
              { count: row.topicCount },
            )}
          </span>
          <Switch
            checked={row.enabled}
            disabled={disabled || saving !== null}
            aria-busy={saving === row.chatId}
            aria-label={intl.formatMessage({ id: "bots.boundGroups.toggle" }, { name: row.name })}
            onCheckedChange={(enabled) => onToggle(row.chatId, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

export function BoundGroupsCard({ bot }: { bot: BotConfig }) {
  const { intl } = useZCodeIntl();
  const { rows, loading, error, saving, reload, toggle, supported } = useBotBoundGroups(bot);
  return (
    <SettingsGroupCard>
      <section
        className="min-w-0"
        aria-label={intl.formatMessage({ id: "bots.boundGroups.title" })}
      >
        <h3 className="border-b border-border px-4 py-3 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "bots.boundGroups.title" })}
        </h3>
        {loading ? (
          <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "bots.boundGroups.loading" })}
          </p>
        ) : rows.length ? (
          <BoundGroupsList
            rows={rows}
            disabled={!bot.enabled || !supported}
            saving={saving}
            onToggle={(chatId, enabled) => void toggle(chatId, enabled)}
          />
        ) : (
          !error && (
            <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "bots.boundGroups.empty" })}
            </p>
          )
        )}
        {!bot.enabled && (
          <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "bots.boundGroups.botOff" })}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 px-4 py-3 text-ui-sm text-destructive"
          >
            <span>
              {intl.formatMessage({
                id:
                  error === "load" ? "bots.boundGroups.loadFailed" : "bots.boundGroups.saveFailed",
              })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {intl.formatMessage({ id: "bots.boundGroups.refresh" })}
            </Button>
          </div>
        )}
      </section>
    </SettingsGroupCard>
  );
}
