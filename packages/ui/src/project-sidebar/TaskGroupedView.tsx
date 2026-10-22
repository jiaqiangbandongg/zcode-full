import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Hash, Maximize2, Minimize2 } from "lucide-react";
import { OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type {
  ProjectTask,
  ProjectSidebarProps,
  MoveGroupNode,
  TaskGroupColor,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import {
  readGroupedTaskCollapsedGroupIds,
  persistGroupedTaskCollapsedGroupIds,
} from "@/project-sidebar/grouped-expansion.js";
import { buildGroupedTaskView, groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import { GroupItem } from "@/project-sidebar/grouped/group-item.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import { StickyGroupHeaderSlot } from "@/project-sidebar/grouped/sticky-group-header-slot.js";
import { VirtualizedGroupedTopLevelList } from "@/project-sidebar/grouped/virtualized-top-level-list.js";
import { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import {
  GROUPED_TASK_DROP_ANIMATION,
  findNearestScrollableAncestor,
  resolveStickyGroupedTaskGroupId,
} from "@/project-sidebar/grouped/drag.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  findTaskInGroupedView,
  moveTaskByMenu,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  clearV4ComposerDraftTaskGroup,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** 恢复删除前的组件与手势（fd2f4f38a4a^1）；仅将旧事实缓存/applyOrder 改接当前 owner。 */
export function TaskGroupedView({
  tasks,
  onSelect,
  refresh,
  onCreate,
  workspacePath,
  workspaceIdentity,
  onOpenAutomations,
  toolbarTarget,
  stickyTarget,
  scrollRef,
}: {
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(groupId: string | null): void;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenAutomations?: () => void;
  toolbarTarget: HTMLElement | null;
  stickyTarget: HTMLElement | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { groups: organization, loading } = useProjectDirectory();
  const { intl } = useZCodeIntl();
  const presentation = useContext(ProjectTaskListContext);
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftScope = readComposerWorkspaceScope(
    workspacePath,
    workspaceIdentity,
    composerClientNamespace,
  );
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 空正文不再持久化；分组行订阅现有内存草稿，不能靠 localStorage 或手动重绘维持归属。
  const currentDraftGroupId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftTaskGroupId,
  );
  // 查看会话时仅显示尚未提交的文字草稿；首发已移除保存记录，不能复活旧的内存 placement。
  const draftGroupId = activeTaskId
    ? readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, draftScope)
        ?.taskGroupId
    : currentDraftGroupId;
  const [collapsed, setCollapsed] = useState(readGroupedTaskCollapsedGroupIds);
  const changeCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
    setCollapsed((current) => (typeof update === "function" ? update(current) : update));
  }, []);
  useEffect(() => {
    persistGroupedTaskCollapsedGroupIds(collapsed);
  }, [collapsed]);
  const [newGroupSetupId, setNewGroupSetupId] = useState<string | null>(null);
  const [renamingTask, setRenamingTask] = useState<ProjectTask | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renamingTask) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTask]);
  const remoteState = useRemoteWorkspaceSessionStore(
    useShallow((state) => ({
      sessionsById: state.sessionsById,
      sessionIdByWorkspaceIdentity: state.sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath: state.sessionIdByWorkspacePath,
    })),
  );
  const getTaskRemoteSessionId = useCallback(
    (task: ProjectTask) => {
      // 只解析既有 attachment；完整 identity 阻止同路径的另一远端串线。
      return (
        resolveRemoteWorkspaceSessionIdForTarget({
          ...task,
          state: remoteState,
        }) ?? undefined
      );
    },
    [remoteState],
  );
  const authoritativeView = useMemo(
    () => buildGroupedTaskView(tasks, organization.structure),
    [tasks, organization.structure],
  );
  const report = (error: unknown, messageId = "taskGroup.updateFailed") => {
    logger.error("[task-groups] 分组操作失败", error);
    toast(intl.formatMessage({ id: messageId }));
  };
  const action = (work: () => Promise<unknown>, messageId?: string) => {
    void work().catch((error) => report(error, messageId));
  };
  const move = async (command: MoveGroupNode) => {
    try {
      await organization.move(command);
    } catch (error) {
      report(error);
      await organization.refresh();
    }
  };
  const drag = useGroupedDrag({
    authoritativeView,
    collapsedGroupIds: collapsed,
    onCollapsedGroupIdsChange: changeCollapsed,
    onMove: move,
  });
  const groups = useMemo(
    () => drag.view.nodes.flatMap((node) => (node.type === "group" ? [node.group] : [])),
    [drag.view.nodes],
  );
  const allExpanded = groups.every((group) => !collapsed.has(group.id));
  const toggleCollapsed = (id: string) =>
    changeCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const createTask = (groupId: string | null) => {
    if (groupId === OFF_PEAK_DEFAULT_GROUP_ID) {
      onOpenAutomations?.();
      return;
    }
    if (groupId)
      changeCollapsed((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    onCreate(groupId);
  };
  const closeDraft = () => {
    clearV4ComposerDraftTaskGroup(workspacePath, workspaceIdentity, draftScope);
    useZCodeSessionStore.getState().clearDraftTaskGroup(workspacePath, workspaceIdentity);
  };
  useEffect(() => {
    if (draftGroupId !== null || !drag.root.current) return;
    const root = drag.root.current;
    const frame = requestAnimationFrame(() =>
      findNearestScrollableAncestor(root)?.scrollTo({ top: 0 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [draftFocusVersion, draftGroupId, drag.root]);
  const mutate = async (task: ProjectTask, mutation: ProjectTaskMutation) => {
    const result = await mutateProjectTask(
      { service, controller },
      task,
      mutation,
      getTaskRemoteSessionId(task),
    );
    if (mutation.kind === "archive" && mutation.archived)
      useZCodeSessionStore
        .getState()
        .removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
    await refresh();
    return result;
  };
  const moveTask = (task: ProjectTask, groupId?: string | null) => {
    const next =
      groupId === undefined
        ? moveTaskToTopByMenu(authoritativeView, task)
        : moveTaskByMenu(authoritativeView, task, groupId);
    const command = groupedMoveCommand(authoritativeView, next, {
      type: "task",
      task: groupTaskRef(task),
    });
    if (command) void move(command);
  };
  const updateColor = (id: string, color: TaskGroupColor) =>
    action(() => organization.save({ id, color }));
  const ungroup = (id: string) => action(() => organization.ungroup(id));
  const getWorkspaceLabel = (task: Pick<ProjectTask, "workspacePath" | "workspacePurpose">) =>
    task.workspacePurpose === "conversation"
      ? intl.formatMessage({ id: "workspaceSidebar.conversationsSection" })
      : task.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || task.workspacePath;
  const rowCallbacks = {
    groups,
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    activeTaskId,
    mobileActiveTaskKey: presentation.mobileActiveTaskKey,
    onSelectTask: (path: string, id: string, identity?: string) => {
      const task = findTaskInGroupedView(
        authoritativeView,
        taskKey({ workspacePath: path, taskId: id, workspaceIdentity: identity }),
      );
      onSelect(path, id, identity, task ? getTaskRemoteSessionId(task) : undefined, task?.unreadAt);
    },
    onCloseTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onArchiveTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onOpenFileTree: presentation.onOpenTaskFiles
      ? (task: ProjectTask) =>
          action(() => presentation.onOpenTaskFiles!(task, getTaskRemoteSessionId(task)))
      : undefined,
    onMoveTaskToGroup: (task: ProjectTask, id: string | null) => moveTask(task, id),
    onMoveTaskToTop: (task: ProjectTask) => moveTask(task),
    onStartRenameTask: (task: ProjectTask) => {
      setRenamingTask(task);
      setRenameDraft(task.title ?? "");
    },
    onMarkTaskAsUnread: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "mark-unread" }), "taskList.markAsUnreadFailed"),
    tooltipsDisabled: drag.dragging,
  };
  const [stickyId, setStickyId] = useState<string | null>(null);
  useEffect(() => {
    const root = drag.root.current;
    if (!root || drag.dragging) {
      setStickyId(null);
      return;
    }
    // 展开动画首帧尚无 overflow，不能因此漏订阅后续滚动；当前滚动 owner 由侧栏直接提供。
    const scroll = scrollRef.current;
    if (!scroll) {
      setStickyId(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setStickyId(resolveStickyGroupedTaskGroupId(root));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [scrollRef, drag.root, drag.dragging, drag.view.nodes, collapsed, draftGroupId]);
  const sticky = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === stickyId,
  );
  const activeTask = drag.activeTaskKey
    ? findTaskInGroupedView(drag.view, drag.activeTaskKey)
    : null;
  const activeGroup = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === drag.activeGroupId,
  );
  const overlayStyle = drag.width ? { width: `${drag.width}px` } : undefined;
  const toggleLabel = intl.formatMessage({
    id: allExpanded ? "taskGroup.collapseAll" : "taskGroup.expandAll",
  });
  return (
    <>
      {toolbarTarget &&
        createPortal(
          <>
            <ControlHintTooltip title={toggleLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={toggleLabel}
                data-testid="task-group-toggle-all"
                disabled={!groups.length}
                onClick={() =>
                  changeCollapsed(
                    allExpanded ? new Set(groups.map((group) => group.id)) : new Set(),
                  )
                }
              >
                {allExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newGroup" })}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid="task-group-add"
                aria-label={intl.formatMessage({ id: "taskGroup.newGroup" })}
                disabled={!organization.available}
                onClick={() =>
                  action(async () => {
                    const group = await organization.save({
                      title: intl.formatMessage({ id: "taskGroup.defaultTitle" }),
                    });
                    setNewGroupSetupId(group.id);
                  }, "taskGroup.createFailed")
                }
              >
                <Hash className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </>,
          toolbarTarget,
        )}
      {stickyTarget &&
        createPortal(
          <StickyGroupHeaderSlot
            header={
              sticky?.type === "group" ? (
                <StickyGroupHeader
                  node={sticky}
                  collapsed={collapsed.has(sticky.group.id)}
                  tooltipsDisabled={drag.dragging}
                  onCreateTask={() => createTask(sticky.group.id)}
                  onToggleCollapsed={toggleCollapsed}
                  onUpdateGroupColor={updateColor}
                  onUngroupGroup={ungroup}
                />
              ) : null
            }
          />,
          stickyTarget,
        )}
      <TaskRenameDialog
        open={renamingTask !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) setRenamingTask(null);
        }}
        onChange={setRenameDraft}
        onCancel={() => setRenamingTask(null)}
        onConfirm={() =>
          action(async () => {
            if (!renamingTask) return;
            await mutate(renamingTask, { kind: "rename", title: renameDraft.trim() });
            setRenamingTask(null);
          }, "taskList.renameFailed")
        }
      />
      <DndContext {...drag.dnd}>
        <div ref={drag.root} className="px-2 pb-4" data-testid="task-grouped-view">
          {draftGroupId === null && (
            <GroupedDraftTaskRow
              active={!activeTaskId}
              workspaceLabel={getWorkspaceLabel({ workspacePath })}
              onSelect={() => createTask(null)}
              onClose={closeDraft}
            />
          )}
          <VirtualizedGroupedTopLevelList
            nodes={drag.view.nodes}
            isGroupCollapsed={(id) => collapsed.has(id)}
            renderNode={(node) =>
              node.type === "group" ? (
                <div key={node.group.id} data-grouped-layout-key={`group:${node.group.id}`}>
                  <GroupItem
                    {...rowCallbacks}
                    node={node}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getWorkspaceLabel}
                    onCreateTask={() => createTask(node.group.id)}
                    hasDraftTask={draftGroupId === node.group.id}
                    draftTaskActive={!activeTaskId}
                    draftWorkspaceLabel={getWorkspaceLabel({ workspacePath })}
                    onSelectDraftTask={() => createTask(node.group.id)}
                    onCloseDraftTask={closeDraft}
                    onRenameGroup={(id, title) =>
                      action(() => organization.save({ id, title }), "taskGroup.renameFailed")
                    }
                    onUpdateGroupColor={updateColor}
                    onUngroupGroup={ungroup}
                    newGroupSetup={newGroupSetupId === node.group.id}
                    onNewGroupSetupStarted={(id) =>
                      setNewGroupSetupId((current) => (current === id ? null : current))
                    }
                    collapsed={collapsed.has(node.group.id)}
                    onToggleCollapsed={toggleCollapsed}
                    activeDragTaskKey={drag.activeTaskKey}
                    activeDragGroupId={drag.activeGroupId}
                  />
                </div>
              ) : (
                <GroupedTaskItem
                  {...rowCallbacks}
                  key={taskKey(node.task)}
                  task={node.task}
                  remoteSessionId={getTaskRemoteSessionId(node.task)}
                  workspaceLabel={getWorkspaceLabel(node.task)}
                  dragId={taskKey(node.task)}
                  dragging={drag.activeTaskKey === taskKey(node.task)}
                />
              )
            }
          />
          {drag.view.nodes.length === 0 && draftGroupId === undefined && !loading && (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.noTasks" })}
            </div>
          )}
          {organization.error && (
            <p role="alert" className="px-3 text-ui-sm text-destructive">
              {organization.error}
            </p>
          )}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
            {activeTask ? (
              <div
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
                style={overlayStyle}
              >
                <GroupedTaskItem
                  {...rowCallbacks}
                  task={activeTask}
                  remoteSessionId={getTaskRemoteSessionId(activeTask)}
                  workspaceLabel={getWorkspaceLabel(activeTask)}
                  dragId={drag.activeTaskKey ?? undefined}
                  dragOverlay
                />
              </div>
            ) : activeGroup?.type === "group" ? (
              <GroupDragOverlay
                node={activeGroup}
                style={overlayStyle}
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
