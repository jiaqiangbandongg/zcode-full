import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
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
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickInputClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const TASK_SEARCH_RESULT_LIMIT = 9;
const TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT = 3;

type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
  kind: "task" | "snippet" | "expand";
  hiddenSnippetCount?: number;
  showTaskHeader: boolean;
};

function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

export function TaskSearchDialog({
  workspaceTabs,
  onSelectTask,
  onSelectSearchResult,
  openRequestId = 0,
}: {
  workspaceTabs: WorkspaceTabState[];
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSelectSearchResult?: (
    task: TaskSearchResultItem,
    context: { query: string; searchSnippet?: string; snippetIndex?: number },
  ) => void;
  openRequestId?: number;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(() => new Set());
  const shortcutLabel = formatCommandShortcutLabel("G");
  const trimmedQuery = query.trim();
  const searchWorkspaceTabs = useMemo(
    () => (open ? workspaceTabs : []),
    [open, workspaceTabs],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    // 修复原因：搜索弹窗组件常驻在 App 里，但未打开时不需要 recent/search 结果。
    // 传空 workspace 可以复用 useGlobalTaskList 的空态路径，避免空闲时多一组 listTaskList
    // 和 workspace 事件订阅，减轻启动期 renderer/RPC 压力。
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery: trimmedQuery,
    expanded: false,
    collapsedLimit: TASK_SEARCH_RESULT_LIMIT,
  });
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.label]),
      ),
    [workspaceTabs],
  );
  const hasQuery = trimmedQuery.length > 0;
  const getTaskResultKey = useCallback(
    (task: Pick<TaskSearchResultItem, "workspaceIdentity" | "workspacePath" | "taskId">) =>
      `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`,
    [],
  );
  const visibleResults = useMemo<TaskSearchResultRow[]>(() => {
    const rows: TaskSearchResultRow[] = [];
    const taskByKey = new Map<string, TaskSearchResultItem>();
    for (const task of taskList.items) {
      const taskKey = getTaskResultKey(task);
      const existingTask = taskByKey.get(taskKey);
      if (!existingTask) {
        taskByKey.set(taskKey, task);
        continue;
      }

      // Bugfix: 搜索结果可能从查询缓存和跨工作区聚合路径带入同一个 task。
      // 这里先按会话 key 合并，再按片段文本去重，避免列表里出现重复标题或重复摘要。
      taskByKey.set(taskKey, {
        ...existingTask,
        searchSnippets: [
          ...getUniqueTaskSearchSnippets(existingTask),
          ...getUniqueTaskSearchSnippets(task),
        ],
      });
    }

    for (const task of taskByKey.values()) {
      const taskKey = getTaskResultKey(task);
      const snippets = hasQuery
        ? getUniqueTaskSearchSnippets(task)
        : [];
      if (snippets.length === 0) {
        rows.push({
          key: taskKey,
          task,
          kind: "task",
          showTaskHeader: true,
        });
      } else {
        const isExpanded = expandedTaskKeys.has(taskKey);
        const visibleSnippets = isExpanded
          ? snippets
          : snippets.slice(0, TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT);
        visibleSnippets.forEach((snippet, snippetIndex) => {
          rows.push({
            key: `${taskKey}:${snippetIndex}`,
            task,
            searchSnippet: snippet,
            snippetIndex,
            kind: "snippet",
            showTaskHeader: snippetIndex === 0,
          });
        });
        if (!isExpanded && snippets.length > TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT) {
          rows.push({
            key: `${taskKey}:expand`,
            task,
            kind: "expand",
            hiddenSnippetCount: snippets.length - TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT,
            showTaskHeader: false,
          });
        }
      }

      if (!expandedTaskKeys.has(taskKey) && rows.length >= TASK_SEARCH_RESULT_LIMIT) {
        break;
      }
    }

    return expandedTaskKeys.size > 0 ? rows : rows.slice(0, TASK_SEARCH_RESULT_LIMIT);
  }, [expandedTaskKeys, getTaskResultKey, hasQuery, taskList.items]);
  const emptyLabel = taskList.loading
    ? intl.formatMessage({ id: "taskSearch.loading" })
    : intl.formatMessage({ id: hasQuery ? "taskSearch.noResults" : "taskSearch.noRecent" });

  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      if (row.kind === "expand") {
        setExpandedTaskKeys((current) => new Set(current).add(getTaskResultKey(row.task)));
        return;
      }

      onSelectSearchResult?.(row.task, {
        query: trimmedQuery,
        searchSnippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [getTaskResultKey, onSelectSearchResult, onSelectTask, trimmedQuery],
  );
  const selectTaskHeader = useCallback(
    (task: TaskSearchResultItem) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [onSelectTask],
  );

  useEffect(() => {
    if (!open || !trimmedQuery) {
      return;
    }

    // Bugfix: 正文搜索上线后，旧的空搜索结果可能已经被 task query cache 记为 fresh。
    // 弹窗输入查询词时主动刷新一次，确保服务层新补的正文索引和按需回填逻辑能够生效。
    void taskList.refresh();
  }, [open, taskList.refresh, trimmedQuery]);

  useEffect(() => {
    setExpandedTaskKeys(new Set());
  }, [trimmedQuery]);

  useEffect(() => {
    if (!open || !trimmedQuery) {
      return;
    }

    const snippetCount = visibleResults.filter((result) => result.searchSnippet?.trim()).length;
    logger.info(
      `[TaskSearchDialog] 搜索结果 query=${JSON.stringify(trimmedQuery)} items=${visibleResults.length} snippets=${snippetCount} firstSnippet=${JSON.stringify(visibleResults[0]?.searchSnippet?.slice(0, 80) ?? "")}`,
    );
  }, [open, trimmedQuery, visibleResults]);

  useEffect(() => {
    if (openRequestId <= 0) {
      return;
    }

    setOpen(true);
  }, [openRequestId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const index = visibleResults.findIndex((_, itemIndex) =>
        matchesPrimaryShortcut(event, String(itemIndex + 1)),
      );
      if (index < 0) {
        return;
      }

      event.preventDefault();
      const result = visibleResults[index];
      if (result) {
        selectTask(result);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selectTask, visibleResults]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-icon="inline-start"
        size="lg"
        className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
      >
        <Search className="size-4" />
        <span className="min-w-0 flex-1 truncate text-left">
          {intl.formatMessage({ id: "taskSearch.button" })}
        </span>
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {shortcutLabel}
        </span>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
            setExpandedTaskKeys(new Set());
          }
        }}
        title={intl.formatMessage({ id: "taskSearch.title" })}
        description={intl.formatMessage({ id: "taskSearch.description" })}
        className={quickPickDialogClassName}
      >
        <Command shouldFilter={false} className={quickPickCommandClassName}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={intl.formatMessage({ id: "taskSearch.placeholder" })}
            className={quickPickInputClassName}
          />
          <CommandList className={quickPickListClassName}>
            <CommandGroup heading={intl.formatMessage({ id: "taskSearch.recent" })}>
              {visibleResults.length === 0 ? (
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {emptyLabel}
                </CommandEmpty>
              ) : null}
              {visibleResults.map((result, index) => {
                const task = result.task;
                const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
                const workspaceLabel =
                  workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
                  task.workspacePath;
                const searchSnippet = hasQuery ? result.searchSnippet?.trim() : undefined;
                const isExpandRow = result.kind === "expand";
                const showTaskHeader = result.showTaskHeader;

                return (
                  <Fragment key={result.key}>
                    {showTaskHeader && searchSnippet ? (
                      <button
                        type="button"
                        className="mt-1 flex min-w-0 w-full cursor-default items-center gap-2 rounded-md px-2.5 pb-0.5 pt-1 text-left outline-hidden first:mt-0 hover:bg-menu-hover focus-visible:bg-menu-hover"
                        onClick={() => selectTaskHeader(task)}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui-base leading-5 font-normal text-foreground">
                          <HighlightedMatchText text={title} query={query} />
                        </span>
                        <CommandShortcut className={quickPickMetadataClassName}>
                          {workspaceLabel}
                        </CommandShortcut>
                        <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs leading-none tracking-normal text-foreground-subtlest">
                          {formatTaskRelativeTime(task.updatedAt, intl)}
                        </span>
                      </button>
                    ) : null}
                    <CommandItem
                      value={`${title} ${workspaceLabel} ${searchSnippet ?? ""}`}
                      className={isExpandRow ? "min-h-7 items-center px-2.5 text-ui-base" : quickPickItemClassName}
                      onSelect={() => selectTask(result)}
                    >
                      {isExpandRow ? (
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base font-normal text-foreground-subtle">
                          <ChevronDown className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {intl.formatMessage(
                              { id: "taskSearch.expandMoreSnippets" },
                              { count: String(result.hiddenSnippetCount ?? 0) },
                            )}
                          </span>
                        </span>
                      ) : (
                        <>
                          <span
                            className={
                              "flex min-w-0 flex-1 flex-col justify-center py-0.5"
                            }
                          >
                            {searchSnippet ? (
                              <span className="min-w-0 truncate text-ui-base font-normal leading-4 text-foreground-subtle">
                                <HighlightedMatchText text={searchSnippet} query={query} />
                              </span>
                            ) : (
                              <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                                <HighlightedMatchText text={title} query={query} />
                              </span>
                            )}
                          </span>
                          {!searchSnippet ? (
                            <>
                              <CommandShortcut className={quickPickMetadataClassName}>
                                {workspaceLabel}
                              </CommandShortcut>
                              <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs tracking-normal text-foreground-subtlest">
                                {formatTaskRelativeTime(task.updatedAt, intl)}
                              </span>
                            </>
                          ) : null}
                          <span className={quickPickShortcutPillClassName}>
                            {formatCommandShortcutLabel(String(index + 1))}
                          </span>
                        </>
                      )}
                    </CommandItem>
                  </Fragment>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
