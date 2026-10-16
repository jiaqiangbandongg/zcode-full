import { PuzzleIcon, Trash2Icon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";
import {
  formatPluginUiContextLabel,
  type PluginUiModelContext,
} from "../domain/pluginUiModelContext.js";

export const TID_PLUGIN_UI_MODEL_CONTEXT_CHIP = "plugin-ui-model-context-chip";

/** composer 与历史用户消息共用的"插件上下文"pill；与 WebElementContextAttachmentChip 同构。 */
export function PluginUiModelContextChip({
  contexts,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  contexts: readonly PluginUiModelContext[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (contexts.length === 0) return null;
  const label = intl.formatMessage({ id: "pluginUi.modelContext.label" });
  const removeLabel = intl.formatMessage({ id: "pluginUi.modelContext.remove" });
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<PuzzleIcon className="size-4 shrink-0 text-foreground-subtle" />}
      label={contexts.length === 1 ? label : `${label} · ${contexts.length}`}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
      triggerProps={{ "data-testid": TID_PLUGIN_UI_MODEL_CONTEXT_CHIP }}
    >
      {contexts.map((context) => (
        <div
          key={context.id}
          className="group/context flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{formatPluginUiContextLabel(context)}</div>
            <div className="line-clamp-3 whitespace-pre-wrap text-ui-base text-foreground-subtle">
              {context.text}
            </div>
          </div>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
