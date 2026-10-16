/* eslint-disable max-lines -- 手机远控首页集中编排 workspace card、task row、加载态和交互态，后续筛选/搜索落地时再按子组件边界拆分。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Clock3,
  Cloud,
  FolderOpen,
  LoaderIcon,
  MessageCircleCheck,
  MessageCirclePlus,
  Pin,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import {
  TID_TASK_ITEM,
  resolveWebRemoteControlWorkspaceKey,
  testId,
  type WebRemoteControlTaskDisplayStatus,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  buildWebRemoteControlTaskRowKey,
  useWebRemoteControlTaskOpen,
} from "@/hooks/useWebRemoteControlTaskOpen.js";
import { getErrorMessage } from "@/hooks/chatActionHelpers.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import {
  getTaskTimelineGroupMessage,
  groupTaskTimelineItems,
} from "@/lib/taskTimelineGroups.js";
import {
  EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
  buildWebRemoteControlMobileTaskHomeModel,
  getWebRemoteControlTaskStatusClassName,
  getWorkspaceLatestUpdatedAt,
  hasWebRemoteControlMobileTaskHomeActiveTaskMatch,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/lib/webRemoteControlMobileTaskHome.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";

export { buildWebRemoteControlMobileTaskHomeModel } from "@/lib/webRemoteControlMobileTaskHome.js";
export {
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/lib/webRemoteControlMobileTaskHome.js";

function getStatusIcon(status: WebRemoteControlTaskDisplayStatus) {
  if (status === "running") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }

  if (status === "completed") {
    return <CheckCircle2 className="size-3" />;
  }

  if (status === "error") {
    return <AlertCircle className="size-3" />;
  }

  return null;
}

function noopSelectTask() {}

export function WebRemoteControlMobileTaskHome({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  initialResult,
  onNavigateHome,
  onNavigateToChat,
  onOpenTask,
  preferences,
  onPreferencesChange,
  onSelectTask = noopSelectTask,
  onStartDraftInWorkspace,
  refreshKey,
  onCrossWorkspaceSwitchingChange,
  switcher,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialResult?: WebRemoteControlWorkspaceListResult;
  onSelectTask?: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace?: (
    targetWorkspacePath: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onNavigateHome?: () => void;
  onNavigateToChat?: () => void;
  onOpenTask?: (task: WebRemoteControlTaskTarget) => void;
  preferences: WebRemoteControlMobileTaskHomePreferences;
  onPreferencesChange: (preferences: WebRemoteControlMobileTaskHomePreferences) => void;
  refreshKey?: number;
  onCrossWorkspaceSwitchingChange?: (switching: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [result, setResult] = useState<WebRemoteControlWorkspaceListResult>(
    initialResult ?? EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
  );
  const [loading, setLoading] = useState(!initialResult);
  const [loadError, setLoadError] = useState<string | null>(null);
  const taskOrganizeBy = preferences.organizeBy;
  const taskSortBy = preferences.sortBy;
  const initialExpansionModel = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result: initialResult ?? EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, initialResult, taskSortBy],
  );
  const [expandedWorkspaceKeys, setExpandedWorkspaceKeys] = useState<Set<string>>(
    () => new Set(initialExpansionModel.defaultExpandedWorkspaceKeys),
  );
  const didInitializeLoadedExpansionRef = useRef(Boolean(initialResult));
  const model = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result,
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, result, taskSortBy],
  );
  const defaultExpandedWorkspaceKeySignature = useMemo(
    () => [...model.defaultExpandedWorkspaceKeys].join("\0"),
    [model.defaultExpandedWorkspaceKeys],
  );
  const workspaceByKey = useMemo(
    () => new Map(model.groups.map((group) => [group.workspaceKey, group.workspace])),
    [model.groups],
  );
  const timelineGroups = useMemo(
    () =>
      // Bugfix: 手机时间线之前只平铺已排序 task，缺少桌面端“今天/上月”等分组文案。
      // 这里复用桌面时间线分组工具，保证排序字段、locale 周起始日和文案 key 都保持一致。
      groupTaskTimelineItems(model.timelineTasks, {
        sortBy: taskSortBy,
        now: Date.now(),
        locale,
      }),
    [locale, model.timelineTasks, taskSortBy],
  );
  const {
    error: taskOpenError,
    openTask,
    switchingTaskKey,
  } = useWebRemoteControlTaskOpen({
    activeTaskId: model.activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    markTaskReadOnOpen: true,
    mobileNavigationIntent: "chat",
    onNavigateHome,
    onNavigateToChat,
    onSelectTask,
    onSwitchingChange: onCrossWorkspaceSwitchingChange,
    switcher,
  });
  const error = loadError ?? taskOpenError;

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await switcher.listWorkspaces());
    } catch (err) {
      // Bugfix: 远控请求失败时可能抛普通对象，直接 String 会把真实原因吞成 [object Object]。
      const message = getErrorMessage(err);
      logger.error("[WebRemoteControlMobileTaskHome] 加载远控首页失败", {
        error: message,
      });
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [switcher]);

  useEffect(() => {
    if (initialResult) {
      return;
    }

    // Bugfix: 手机端任务首页之前每 3 秒轮询 listWorkspaces，导致 relay 持续产生任务列表请求。
    // 这里只保留首次无 initialResult 时加载；从聊天页返回首页由 WebRemoteControlMobileShell 显式 refreshKey 触发一次刷新。
    void loadWorkspaces();
  }, [initialResult, loadWorkspaces]);

  useEffect(() => {
    if (!refreshKey) {
      return;
    }

    // Bugfix: 取消 3 秒轮询后，用户从 task 页返回任务列表时仍需要看到刚发送消息后的最新状态。
    // 这里把“返回列表”作为一次明确刷新事件，避免持续请求，同时保证 loading / 选中态及时更新。
    void loadWorkspaces();
  }, [loadWorkspaces, refreshKey]);

  useEffect(() => {
    return switcher.onWorkspaceListUpdated?.((nextResult) => {
      // Bugfix: 桌面端或宽屏远控变更 task membership 后，手机首页需要采用推送的最新索引。
      // 继续只在明确事件上刷新，避免恢复到旧的定时轮询。
      setResult(nextResult);
      setLoadError(null);
      setLoading(false);
    });
  }, [switcher]);

  useEffect(() => {
    if (didInitializeLoadedExpansionRef.current || loading) {
      return;
    }

    didInitializeLoadedExpansionRef.current = true;
    setExpandedWorkspaceKeys(new Set(model.defaultExpandedWorkspaceKeys));
  }, [defaultExpandedWorkspaceKeySignature, loading, model.defaultExpandedWorkspaceKeys]);

  useEffect(() => {
    if (loading || result.workspaces.length === 0) {
      return;
    }

    const activeGroup = model.groups.find(
      (group) => group.workspaceKey === model.activeWorkspaceKey,
    );
    if (!activeGroup) {
      logger.warn("[WebRemoteControlMobileTaskHome] 初始 workspace 未匹配", {
        workspaceKey: model.activeWorkspaceKey,
      });
      return;
    }

    if (!hasWebRemoteControlMobileTaskHomeActiveTaskMatch(model)) {
      logger.warn("[WebRemoteControlMobileTaskHome] 初始 task 未匹配", {
        taskId: model.activeTaskId,
        workspaceKey: model.activeWorkspaceKey,
      });
    }
  }, [
    loading,
    model.activeTaskId,
    model.activeWorkspaceKey,
    model.groups,
    result.workspaces.length,
  ]);

  const toggleWorkspace = useCallback((workspaceKey: string) => {
    setExpandedWorkspaceKeys((current) => {
      const next = new Set(current);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return next;
    });
  }, []);

  const collapseAllWorkspaces = useCallback(() => {
    setExpandedWorkspaceKeys(new Set());
  }, []);

  const handleOpenTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      if (onOpenTask) {
        onOpenTask(task);
        return;
      }

      openTask(task);
    },
    [onOpenTask, openTask],
  );
  const [creatingWorkspaceKey, setCreatingWorkspaceKey] = useState<string | null>(null);
  const [reconnectingWorkspaceKey, setReconnectingWorkspaceKey] = useState<string | null>(null);
  const handleReconnectWorkspace = useCallback(
    async (workspace: WebRemoteControlWorkspaceListResult["workspaces"][number]) => {
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
      if (!switcher.reconnectWorkspace) {
        return;
      }

      setLoadError(null);
      setReconnectingWorkspaceKey(workspaceKey);
      try {
        // Bugfix: 手机端列表现在会展示已断开的 SSH 工作区，不能再误走 bridge。
        // 重连请求必须交回桌面 renderer 复用原有 SSH 恢复流程，再刷新列表拿最新连接态。
        await switcher.reconnectWorkspace(workspaceKey);
        await loadWorkspaces();
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error("[WebRemoteControlMobileTaskHome] 手机端重连远程工作区失败", {
          error: message,
          workspaceKey,
        });
        setLoadError(message);
      } finally {
        setReconnectingWorkspaceKey(null);
      }
    },
    [loadWorkspaces, switcher],
  );
  const handleStartDraft = useCallback(
    async (workspace: WebRemoteControlWorkspaceListResult["workspaces"][number]) => {
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
      const isCrossWorkspace = workspaceKey !== model.activeWorkspaceKey;
      setLoadError(null);
      setCreatingWorkspaceKey(workspaceKey);
      onCrossWorkspaceSwitchingChange?.(true);
      try {
        // Bugfix: 手机端“新建任务”如果只切 workspace 不清空 activeTask，
        // 远控会继续带着旧 taskId 进入聊天页，看起来像按钮无效。
        // 这里统一走 startDraft（可选）或 switchWorkspace(不带 taskId)，确保进入草稿态。
        if (switcher.startDraft) {
          await switcher.startDraft(workspaceKey, { mobileNavigationIntent: "chat" });
        } else {
          await switcher.switchWorkspace(workspaceKey, { mobileNavigationIntent: "chat" });
          await switcher.updateMobileViewState?.(workspaceKey);
        }
        if (!isCrossWorkspace) {
          onStartDraftInWorkspace?.(workspace.workspacePath, workspace.workspaceIdentity);
          onNavigateToChat?.();
        }
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error("[WebRemoteControlMobileTaskHome] 手机端新建任务失败", {
          error: message,
          workspaceKey,
        });
        setLoadError(message);
      } finally {
        setCreatingWorkspaceKey(null);
        onCrossWorkspaceSwitchingChange?.(false);
      }
    },
    [
      model.activeWorkspaceKey,
      onCrossWorkspaceSwitchingChange,
      onNavigateToChat,
      onStartDraftInWorkspace,
      switcher,
    ],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-header px-4 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-ui-lg font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileHome.title" })}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "webRemoteControl.mobileHome.connected",
              })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WebRemoteControlThemeMenu />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-lg border border-card-border bg-card p-3 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileHome.notice" })}
        </div>

        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-ui-base font-medium">
              {intl.formatMessage({
                id: "webRemoteControl.mobileHome.sectionTitle",
              })}
            </h1>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "webRemoteControl.mobileHome.summary" },
                {
                  taskCount: String(model.totalTaskCount),
                  workspaceCount: String(model.totalWorkspaceCount),
                },
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {taskOrganizeBy === "workspace" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({
                  id: "webRemoteControl.mobileHome.collapseAll",
                })}
                onClick={collapseAllWorkspaces}
              >
                <ChevronsUp className="size-3.5" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileHome.organize",
                  })}
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 min-w-52">
                <DropdownMenuLabel>
                  {intl.formatMessage({
                    id: "webRemoteControl.mobileHome.organize",
                  })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskOrganizeBy}
                  onValueChange={(value) => {
                    if (value === "workspace" || value === "timeline") {
                      // Bugfix: 手机远控首页会在进入 task 后卸载，排序/分组偏好不能留在本组件本地 state。
                      // 这里把用户选择回写到 shell 级状态，返回任务列表时继续沿用上一次设置。
                      onPreferencesChange({ ...preferences, organizeBy: value });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="workspace">
                    <FolderOpen className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.organizeByWorkspace",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="timeline">
                    <Clock3 className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.organizeByTimeline",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  {intl.formatMessage({
                    id: "webRemoteControl.mobileHome.sortBy",
                  })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskSortBy}
                  onValueChange={(value) => {
                    if (value === "created" || value === "updated") {
                      onPreferencesChange({ ...preferences, sortBy: value });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="created">
                    <MessageCirclePlus className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.sortByCreated",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="updated">
                    <MessageCircleCheck className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.sortByUpdated",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({
                id: "webRemoteControl.mobileHome.refresh",
              })}
              onClick={() => {
                void loadWorkspaces();
              }}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive">
            {error}
          </div>
        ) : null}

        {loading && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 flex items-center gap-2 px-1 py-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : null}

        {!loading && !error && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 px-1 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.noTasks" })}
          </div>
        ) : null}

        {model.pinnedTasks.length > 0 ? (
          <section className="mt-3">
            <h2 className="px-1 py-1 text-ui-base font-medium text-foreground-subtlest">
              {intl.formatMessage({ id: "taskList.pinnedSection" })}
            </h2>
            <ul className="space-y-1">
              {model.pinnedTasks.map((task) => {
                const rowKey = buildWebRemoteControlTaskRowKey(task);
                const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                const taskWorkspace = workspaceByKey.get(taskWorkspaceKey);
                const isDisconnectedRemoteWorkspace =
                  taskWorkspace?.kind === "remote" &&
                  (taskWorkspace.connectionState === "disconnected" ||
                    !taskWorkspace.remoteSessionId);
                const selected =
                  taskWorkspaceKey === model.activeWorkspaceKey &&
                  task.taskId === model.activeTaskId;
                const switching = switchingTaskKey === rowKey;
                const taskTitle =
                  task.title || intl.formatMessage({ id: "taskList.untitled" });
                const displayStatus = task.displayStatus ?? "idle";

                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      data-testid={testId(TID_TASK_ITEM, task.taskId)}
                      data-state={selected ? "selected" : "idle"}
                      className={cn(
                        "flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                        selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                      )}
                      disabled={Boolean(switchingTaskKey) || isDisconnectedRemoteWorkspace}
                      onClick={() => {
                        if (!isDisconnectedRemoteWorkspace) {
                          handleOpenTask(task);
                        }
                      }}
                      aria-label={intl.formatMessage(
                        { id: "webRemoteControl.openTask" },
                        { title: taskTitle },
                      )}
                    >
                      <span className="relative flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
                        {switching ? (
                          <LoaderIcon className="size-4 animate-spin" />
                        ) : (
                          <Pin className="size-4" />
                        )}
                        {!switching && task.unreadAt ? (
                          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-base text-foreground">
                          {taskTitle}
                        </span>
                        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                          <span className="truncate">
                            {taskWorkspace?.workspacePurpose === "conversation"
                              ? intl.formatMessage({
                                  id: "workspaceSidebar.conversationsSection",
                                })
                              : task.workspaceLabel || taskWorkspace?.label || task.workspacePath}
                          </span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">
                            {formatTaskRelativeTime(
                              taskSortBy === "created" ? task.createdAt : task.updatedAt,
                              intl,
                            )}
                          </span>
                        </span>
                        {task.workflowActivity ? (
                          <TaskWorkflowRunLines
                            activity={task.workflowActivity}
                            isActive={selected}
                            intl={intl}
                            density="compact"
                          />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                          getWebRemoteControlTaskStatusClassName(displayStatus),
                        )}
                      >
                        {getStatusIcon(displayStatus)}
                        {intl.formatMessage({
                          id: `webRemoteControl.taskStatus.${displayStatus}`,
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {taskOrganizeBy === "timeline" ? (
          <ul className="mt-3 space-y-2">
            {model.totalTaskCount === 0 && model.totalWorkspaceCount > 0 ? (
              <li className="px-1 py-2 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "webRemoteControl.noTasks" })}
              </li>
            ) : null}
            {timelineGroups.map((group) => {
              const labelMessage = getTaskTimelineGroupMessage(group.label);

              return (
                <li key={group.key} className="space-y-1">
                  <div className="px-1 py-1 text-ui-base font-medium text-foreground-subtle">
                    {intl.formatMessage(
                      { id: labelMessage.id },
                      labelMessage.values,
                    )}
                  </div>
                  <ul className="space-y-1">
                    {group.items.map((task) => {
                      const rowKey = buildWebRemoteControlTaskRowKey(task);
                      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                      const taskWorkspace = workspaceByKey.get(taskWorkspaceKey);
                      const isDisconnectedRemoteWorkspace =
                        taskWorkspace?.kind === "remote" &&
                        (taskWorkspace.connectionState === "disconnected" ||
                          !taskWorkspace.remoteSessionId);
                      const selected =
                        taskWorkspaceKey === model.activeWorkspaceKey &&
                        task.taskId === model.activeTaskId;
                      const switching = switchingTaskKey === rowKey;
                      const taskTitle =
                        task.title || intl.formatMessage({ id: "taskList.untitled" });
                      const displayStatus = task.displayStatus ?? "idle";

                      return (
                        <li key={rowKey}>
                          <button
                            type="button"
                            data-testid={testId(TID_TASK_ITEM, task.taskId)}
                            data-state={selected ? "selected" : "idle"}
                            className={cn(
                              "flex min-h-14 w-full min-w-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                              selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                            )}
                            disabled={Boolean(switchingTaskKey) || isDisconnectedRemoteWorkspace}
                            onClick={() => {
                              if (!isDisconnectedRemoteWorkspace) {
                                handleOpenTask(task);
                              }
                            }}
                          >
                            <span className="relative flex size-4 shrink-0 items-center justify-center">
                              {switching ? (
                                <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
                              ) : task.unreadAt ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ui-base text-foreground">
                                {taskTitle}
                              </span>
                              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                                <span className="truncate">
                                  {taskWorkspace?.workspacePurpose === "conversation"
                                    ? intl.formatMessage({
                                        id: "workspaceSidebar.conversationsSection",
                                      })
                                    : task.workspaceLabel ||
                                      taskWorkspace?.label ||
                                      task.workspacePath}
                                </span>
                                <span className="shrink-0">·</span>
                                <span className="truncate">
                                  {formatTaskRelativeTime(
                                    taskSortBy === "created" ? task.createdAt : task.updatedAt,
                                    intl,
                                  )}
                                </span>
                              </span>
                              {task.workflowActivity ? (
                                <TaskWorkflowRunLines
                                  activity={task.workflowActivity}
                                  isActive={selected}
                                  intl={intl}
                                  density="compact"
                                />
                              ) : null}
                            </span>
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                                getWebRemoteControlTaskStatusClassName(displayStatus),
                              )}
                            >
                              {getStatusIcon(displayStatus)}
                              {intl.formatMessage({
                                id: `webRemoteControl.taskStatus.${displayStatus}`,
                              })}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="mt-3 space-y-2">
            {model.groups.map((group) => {
            const expanded = expandedWorkspaceKeys.has(group.workspaceKey);
            const latestUpdatedAt = getWorkspaceLatestUpdatedAt(group.tasks);
            const isDisconnectedRemoteWorkspace =
              group.workspace.kind === "remote" &&
              (group.workspace.connectionState === "disconnected" ||
                !group.workspace.remoteSessionId);
            const reconnecting = reconnectingWorkspaceKey === group.workspaceKey;

            return (
              <li key={group.workspaceKey} className="rounded-lg border border-card-border bg-card">
                <div className="flex min-w-0 items-center gap-2 px-3 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                    onClick={() => toggleWorkspace(group.workspaceKey)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                      {group.workspace.workspacePurpose === "conversation" ? (
                        <MessageCirclePlus className="size-4" />
                      ) : group.workspace.kind === "remote" ? (
                        <Cloud className="size-4" />
                      ) : (
                        <FolderOpen className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-ui-base font-medium text-foreground">
                          {group.workspace.workspacePurpose === "conversation"
                            ? intl.formatMessage({
                                id: "workspaceSidebar.conversationsSection",
                              })
                            : group.workspace.label}
                        </span>
                        <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtle">
                          {intl.formatMessage({
                            id:
                              group.workspace.workspacePurpose === "conversation"
                                ? "webRemoteControl.mobileHome.workspaceKind.conversation"
                                : group.workspace.kind === "remote"
                                ? "webRemoteControl.mobileHome.workspaceKind.remote"
                                : "webRemoteControl.mobileHome.workspaceKind.local",
                          })}
                        </span>
                        {isDisconnectedRemoteWorkspace ? (
                          <span className="shrink-0 rounded-full border border-destructive/40 bg-card px-1.5 py-0.5 text-ui-xs leading-none text-destructive">
                            {intl.formatMessage({
                              id: "webRemoteControl.mobileHome.disconnected",
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block truncate font-mono text-ui-base text-foreground-subtlest">
                        {group.workspace.workspacePath}
                      </span>
                      {group.workspace.lastConnectionError ? (
                        <span className="mt-1 block truncate text-ui-base text-destructive">
                          {group.workspace.lastConnectionError}
                        </span>
                      ) : null}
                      {latestUpdatedAt ? (
                        <span className="mt-1 block text-ui-base text-foreground-subtle">
                          {intl.formatMessage(
                            { id: "webRemoteControl.mobileHome.updatedAt" },
                            {
                              time: formatTaskRelativeTime(latestUpdatedAt, intl),
                            },
                          )}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-ui-base text-foreground-subtle">
                      {!expanded && group.hasUnread ? (
                        <span
                          aria-hidden="true"
                          data-workspace-unread-indicator="true"
                          className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
                        />
                      ) : null}
                      {intl.formatMessage(
                        { id: "webRemoteControl.mobileHome.taskCount" },
                        { count: String(group.tasks.length) },
                      )}
                      {expanded ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </span>
                  </button>
                  {isDisconnectedRemoteWorkspace ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !switcher.reconnectWorkspace ||
                        Boolean(switchingTaskKey) ||
                        Boolean(creatingWorkspaceKey) ||
                        Boolean(reconnectingWorkspaceKey)
                      }
                      onClick={() => {
                        void handleReconnectWorkspace(group.workspace);
                      }}
                    >
                      {reconnecting ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      <span className="sr-only">
                        {intl.formatMessage({
                          id: reconnecting
                            ? "webRemoteControl.mobileHome.reconnecting"
                            : "webRemoteControl.mobileHome.reconnect",
                        })}
                      </span>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        Boolean(switchingTaskKey) ||
                        Boolean(creatingWorkspaceKey) ||
                        Boolean(reconnectingWorkspaceKey)
                      }
                      onClick={() => {
                        void handleStartDraft(group.workspace);
                      }}
                    >
                      {creatingWorkspaceKey === group.workspaceKey ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {/* {intl.formatMessage({ id: "sidebar.newTask" })} */}
                    </Button>
                  )}
                </div>

                {expanded ? (
                  <ul className="border-t border-card-border px-2 py-2">
                    {group.tasks.length === 0 ? (
                      <li className="px-2 py-2 text-ui-base text-foreground-subtle">
                        {intl.formatMessage({
                          id: "webRemoteControl.mobileHome.workspaceEmpty",
                        })}
                      </li>
                    ) : null}
                    {group.tasks.map((task) => {
                      const rowKey = buildWebRemoteControlTaskRowKey(task);
                      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                      const selected =
                        taskWorkspaceKey === model.activeWorkspaceKey &&
                        task.taskId === model.activeTaskId;
                      const switching = switchingTaskKey === rowKey;
                      const taskTitle =
                        task.title || intl.formatMessage({ id: "taskList.untitled" });
                      const displayStatus = task.displayStatus ?? "idle";

                      return (
                        <li key={rowKey}>
                          <button
                            type="button"
                            data-testid={testId(TID_TASK_ITEM, task.taskId)}
                            data-state={selected ? "selected" : "idle"}
                            className={cn(
                              "flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                              selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                            )}
                            disabled={Boolean(switchingTaskKey) || isDisconnectedRemoteWorkspace}
                            onClick={() => {
                              if (!isDisconnectedRemoteWorkspace) {
                                handleOpenTask(task);
                              }
                            }}
                          >
                            <span className="relative flex size-4 shrink-0 items-center justify-center">
                              {switching ? (
                                <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
                              ) : task.unreadAt ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ui-base text-foreground">
                                {taskTitle}
                              </span>
                              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                                <span className="truncate">
                                  {formatTaskRelativeTime(task.updatedAt, intl)}
                                </span>
                              </span>
                              {task.workflowActivity ? (
                                <TaskWorkflowRunLines
                                  activity={task.workflowActivity}
                                  isActive={selected}
                                  intl={intl}
                                  density="compact"
                                />
                              ) : null}
                            </span>
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                                getWebRemoteControlTaskStatusClassName(displayStatus),
                              )}
                            >
                              {getStatusIcon(displayStatus)}
                              {intl.formatMessage({
                                id: `webRemoteControl.taskStatus.${displayStatus}`,
                              })}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
