import { useMemo } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  QUICK_PICK_SECTION_ORDER,
  type QuickPickCommand,
} from "@/quickpick/quickPickCommands.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickInputClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";

export function QuickPickCommandDialog({
  open,
  commands,
  onOpenChange,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const groupedCommands = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commands.filter((command) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commands],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={quickPickDialogClassName}
    >
      <Command className={quickPickCommandClassName}>
        <CommandInput
          placeholder={intl.formatMessage({ id: "quickPick.placeholder" })}
          className={quickPickInputClassName}
          autoFocus
        />
        <CommandList className={quickPickListClassName}>
          <CommandEmpty>{intl.formatMessage({ id: "quickPick.empty" })}</CommandEmpty>
          {groupedCommands.map((section) => (
            <CommandGroup
              key={section.sectionId}
              heading={intl.formatMessage({
                id: `quickPick.section.${section.sectionId}`,
              })}
            >
              {section.commands.map((command) => {
                const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
                const title = intl.formatMessage({ id: command.titleId });
                return (
                  <CommandItem
                    key={command.id}
                    value={`${title} ${command.keywords.join(" ")}`}
                    disabled={command.disabled}
                    className={quickPickItemClassName}
                    onSelect={() => {
                      onOpenChange(false);
                      void Promise.resolve(command.run()).catch((error) => {
                        logger.error("[QuickPick] 命令执行失败", {
                          commandId: command.id,
                          error,
                        });
                        toast(
                          intl.formatMessage(
                            { id: "quickPick.commandFailed" },
                            {
                              error: error instanceof Error ? error.message : String(error),
                            },
                          ),
                        );
                      });
                    }}
                  >
                    <Icon className="size-3.5 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {command.shortcut ? (
                      <CommandShortcut className={quickPickShortcutPillClassName}>
                        {command.shortcut}
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
