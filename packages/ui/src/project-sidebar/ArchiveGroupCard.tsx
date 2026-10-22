import { useState } from "react";
import { ChevronRight, Ellipsis, Folder, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  archiveTaskKey,
  type ArchiveSort,
  type ArchiveGroup,
} from "@/project-sidebar/archive-view.js";
import type { ArchiveOperation } from "@/project-sidebar/useArchiveManagement.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";

export function ArchiveGroupCard({
  group,
  name,
  sort,
  disabled,
  onAction,
}: {
  group: ArchiveGroup;
  name: string;
  sort: ArchiveSort;
  disabled: boolean;
  onAction: (rows: ProjectTask[], operation: ArchiveOperation) => Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const msg = (id: string) => intl.formatMessage({ id: `archives.${id}` });
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        data-testid="archive-group"
        data-project-id={group.projectId ?? ""}
        data-host-id={group.hostId}
        className="min-w-0"
      >
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <Button
                data-testid="archive-group-toggle"
                variant="ghost"
                className="w-full min-w-0 justify-start gap-2 px-0 font-medium hover:bg-transparent focus-visible:bg-hover aria-expanded:bg-transparent"
              >
                <Folder aria-hidden="true" className="size-4 text-foreground-subtle" />
                <span className="min-w-0 truncate" title={name}>
                  {name}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 text-foreground-subtle transition-transform group-data-[state=open]/button:rotate-90"
                />
              </Button>
            </CollapsibleTrigger>
          </h3>
          <span className="shrink-0 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "archives.count" }, { count: group.tasks.length })}
          </span>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="archive-group-menu"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={intl.formatMessage({ id: "archives.groupActions" }, { name })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="archive-group-unarchive"
                onSelect={() => void onAction(group.tasks, "unarchive")}
              >
                {msg("unarchiveAll")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="archive-group-delete"
                variant="destructive"
                onSelect={() => void onAction(group.tasks, "delete")}
              >
                {msg("deleteAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent className="data-[state=open]:pt-3">
          {/* 每组 50 条仍会累积上千行，放大 Select 全局样式重算；收起时不构造或挂载行内容。 */}
          {open ? (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface px-4">
              {group.tasks.slice(0, limit).map((task) => (
                <div
                  key={archiveTaskKey(task)}
                  data-testid="archive-task"
                  data-task-id={task.taskId}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:flex-nowrap"
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <p className="truncate text-ui-base font-medium" title={task.title}>
                      {task.title}
                    </p>
                    <time
                      dateTime={new Date(
                        sort === "created" ? task.createdAt : task.updatedAt,
                      ).toISOString()}
                      className="text-ui-sm text-foreground-subtle"
                    >
                      {dateFormat.format(sort === "created" ? task.createdAt : task.updatedAt)}
                    </time>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                      data-testid="archive-delete"
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={intl.formatMessage(
                        { id: "archives.deleteTask" },
                        { title: task.title },
                      )}
                      onClick={() => void onAction([task], "delete")}
                    >
                      <Trash2 className="size-4 text-foreground-subtle" />
                    </Button>
                    <Button
                      data-testid="archive-unarchive"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => void onAction([task], "unarchive")}
                    >
                      {msg("unarchive")}
                    </Button>
                  </div>
                </div>
              ))}
              {group.tasks.length > limit ? (
                <Button
                  data-testid="archive-show-more"
                  variant="ghost"
                  className="my-2 w-full"
                  onClick={() => setLimit((n) => n + 50)}
                >
                  {msg("showMore")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
