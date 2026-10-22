import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragMoveEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { MoveGroupNode, GroupNode } from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import type { ZCodeGroupedTaskView } from "@/project-sidebar/grouped/types.js";
import { findTaskInGroupedView } from "@/project-sidebar/grouped/view.js";
import {
  getGroupedTaskDragTaskKey,
  getGroupedTaskDragGroupId,
  getGroupedTaskViewSignature,
  getGroupedGroupOverTaskPreviewView,
  getGroupedGroupOverGroupPreviewView,
  getGroupedTaskOverTaskPreviewView,
  getGroupedTaskOverEmptyDropZonePreviewView,
  getGroupedTaskOverGroupFooterPreviewView,
  getGroupedTaskOverGroupHeaderPreviewView,
  getGroupedTaskOverCollapsedGroupPreviewView,
  collectGroupedTaskLayoutRects,
  animateGroupedTaskLayoutFrom,
  measureGroupedTaskPreviewWidth,
  measureGroupedGroupPreviewWidth,
  groupedTaskCollisionDetection,
  GROUPED_TASK_AUTO_SCROLL_THRESHOLD,
} from "@/project-sidebar/grouped/drag.js";
import { logger } from "@/logger.js";

/** 原 WorkspaceGroupedTasksSection 的手势生命周期；持久化替换为当前单节点命令。 */
export function useGroupedDrag({
  authoritativeView,
  collapsedGroupIds,
  onCollapsedGroupIdsChange,
  onMove,
}: {
  authoritativeView: ZCodeGroupedTaskView;
  collapsedGroupIds: Set<string>;
  onCollapsedGroupIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onMove(command: MoveGroupNode): Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<ZCodeGroupedTaskView | null>(null);
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const origin = useRef<ZCodeGroupedTaskView | null>(null);
  const latestPreview = useRef<ZCodeGroupedTaskView | null>(null);
  const direction = useRef<"before" | "after">("after");
  const deltaY = useRef(0);
  const lastOver = useRef<DragOverEvent | null>(null);
  const collapsedSnapshot = useRef<Set<string> | null>(null);
  const animationFrame = useRef<number | null>(null);
  const pendingPreview = useRef<ZCodeGroupedTaskView | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const view = preview ?? authoritativeView;
  const animate = useCallback((next: ZCodeGroupedTaskView) => {
    const rects = collectGroupedTaskLayoutRects(root.current);
    setPreview(next);
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = null;
      animateGroupedTaskLayoutFrom(root.current, rects);
    });
  }, []);
  useEffect(
    () => () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (!activeTaskKey && !activeGroupId) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [activeTaskKey, activeGroupId]);
  const restoreCollapsed = () => {
    if (!collapsedSnapshot.current) return;
    onCollapsedGroupIdsChange(collapsedSnapshot.current);
    collapsedSnapshot.current = null;
  };
  const reset = () => {
    setActiveTaskKey(null);
    setActiveGroupId(null);
    setWidth(null);
    direction.current = "after";
    deltaY.current = 0;
    lastOver.current = null;
    origin.current = null;
    latestPreview.current = null;
    restoreCollapsed();
  };
  const onDragStart = (event: DragStartEvent) => {
    pendingPreview.current = null;
    direction.current = "after";
    deltaY.current = 0;
    lastOver.current = null;
    origin.current = authoritativeView;
    latestPreview.current = authoritativeView;
    setPreview(authoritativeView);
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    if (groupId) {
      collapsedSnapshot.current = new Set(collapsedGroupIds);
      setActiveGroupId(groupId);
      setWidth(measureGroupedGroupPreviewWidth(root.current, groupId));
      onCollapsedGroupIdsChange((current) => new Set(current).add(groupId));
    } else {
      const key = getGroupedTaskDragTaskKey(event.active.data.current);
      if (!key) return;
      setWidth(measureGroupedTaskPreviewWidth(root.current, key));
      setActiveTaskKey(key);
    }
  };
  const applyPreview = (event: DragOverEvent) => {
    const taskKey = getGroupedTaskDragTaskKey(event.active.data.current);
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    if ((!taskKey && !groupId) || !event.over) return;
    const current = latestPreview.current ?? authoritativeView;
    const side = direction.current;
    const next = groupId
      ? getGroupedGroupOverTaskPreviewView(
          getGroupedGroupOverGroupPreviewView(current, event, side),
          event,
          side,
        )
      : getGroupedTaskOverTaskPreviewView(
          getGroupedTaskOverEmptyDropZonePreviewView(
            getGroupedTaskOverGroupFooterPreviewView(
              getGroupedTaskOverGroupHeaderPreviewView(
                getGroupedTaskOverCollapsedGroupPreviewView(current, event, side),
                event,
                side,
              ),
              event,
              side,
            ),
            event,
          ),
          event,
          side,
        );
    if (
      next === current ||
      getGroupedTaskViewSignature(next) === getGroupedTaskViewSignature(current)
    )
      return;
    latestPreview.current = next;
    animate(next);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const previous = direction.current;
    if (event.delta.y > deltaY.current) direction.current = "after";
    else if (event.delta.y < deltaY.current) direction.current = "before";
    deltaY.current = event.delta.y;
    if (direction.current !== previous && lastOver.current) applyPreview(lastOver.current);
  };
  const onDragOver = (event: DragOverEvent) => {
    lastOver.current = event.over ? event : null;
    applyPreview(event);
  };
  const onDragCancel = () => {
    reset();
    setPreview(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const before = origin.current;
    const next = latestPreview.current ?? authoritativeView;
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    const key = getGroupedTaskDragTaskKey(event.active.data.current);
    const task = before && key ? findTaskInGroupedView(before, key) : null;
    const source: GroupNode | null = groupId
      ? { type: "group", groupId }
      : task
        ? { type: "task", task: groupTaskRef(task) }
        : null;
    const command = before && source ? groupedMoveCommand(before, next, source) : null;
    reset();
    if (!command) {
      setPreview(null);
      return;
    }
    logger.debug("[task-groups] 旧版手势提交单节点", command);
    pendingPreview.current = next;
    setPreview(next);
    // 按这次手势的身份收口，旧命令迟到不能清除后来手势的预览。
    void onMove(command).finally(() => {
      if (pendingPreview.current !== next) return;
      pendingPreview.current = null;
      setPreview(null);
    });
  };
  return {
    root,
    view,
    activeTaskKey,
    activeGroupId,
    width,
    dragging: Boolean(activeTaskKey || activeGroupId),
    dnd: {
      sensors,
      autoScroll: { threshold: GROUPED_TASK_AUTO_SCROLL_THRESHOLD },
      collisionDetection: groupedTaskCollisionDetection,
      onDragStart,
      onDragOver,
      onDragMove,
      onDragEnd,
      onDragCancel,
    },
  };
}
