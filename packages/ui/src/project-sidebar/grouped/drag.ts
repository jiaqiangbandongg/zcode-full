// 恢复自分组删除前的碰撞、落点与动画实现；不包含旧数据服务。
import {
  closestCenter,
  type CollisionDetection,
  type DragOverEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import type { ZCodeGroupedTaskView } from "@/project-sidebar/grouped/types.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  moveGroupAroundTopLevelNode,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
} from "@/project-sidebar/grouped/view.js";
export function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY =
      /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (canScrollY) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function getGroupedTaskDragTaskKey(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; taskKey?: unknown };
  return data.type === "grouped-task" && typeof data.taskKey === "string" ? data.taskKey : null;
}

export function getGroupedTaskDragGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group" && typeof data.groupId === "string" ? data.groupId : null;
}

export function getGroupedTaskDragType(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown };
  return typeof data.type === "string" ? data.type : null;
}

export function getGroupedGroupOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group-over" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskCollapsedOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-collapsed-group" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskHeaderOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-header" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskFooterOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-footer" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskEmptyOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-empty-drop-zone" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export type GroupedTaskDragDirectionPosition = "before" | "after";

export const groupedTaskCollisionDetection: CollisionDetection = (args) => {
  const activeType = getGroupedTaskDragType(args.active.data.current);
  const droppableContainers =
    activeType === "grouped-group"
      ? args.droppableContainers.filter((container) => {
          const type = getGroupedTaskDragType(container.data.current);
          return type === "grouped-task" || type === "grouped-group-over";
        })
      : args.droppableContainers.filter(
          (container) => getGroupedTaskDragType(container.data.current) !== "grouped-group-over",
        );
  return closestCenter({
    ...args,
    droppableContainers,
  });
};

export function getGroupedTaskOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeTaskKey || !overTaskKey || activeTaskKey === overTaskKey) {
    return view;
  }
  return moveTaskOverTask(view, {
    activeTaskKey,
    overTaskKey,
    position,
  });
}

export function getGroupedTaskOverCollapsedGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskCollapsedOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position,
  });
}

export function getGroupedTaskOverGroupHeaderPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskHeaderOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToRootAroundGroup(view, {
      activeTaskKey,
      groupId: overGroupId,
      position: "before",
    });
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

export function getGroupedTaskOverGroupFooterPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskFooterOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToGroupEnd(view, {
      activeTaskKey,
      groupId: overGroupId,
    });
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position: "after",
  });
}

export function getGroupedTaskOverEmptyDropZonePreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskEmptyOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

export function getGroupedGroupOverGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overGroupId = getGroupedGroupOverGroupId(event.over?.data.current);
  if (!activeGroupId || !overGroupId || activeGroupId === overGroupId) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "group", groupId: overGroupId },
    position,
  });
}

export function getGroupedGroupOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeGroupId || !overTaskKey) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "task", taskKey: overTaskKey },
    position,
  });
}

export function getGroupedTaskViewSignature(view: ZCodeGroupedTaskView): string {
  return view.nodes
    .map((node) =>
      node.type === "task"
        ? `t:${taskKey(node.task)}`
        : `g:${node.group.id}[${node.tasks.map(taskKey).join(",")}]`,
    )
    .join("|");
}

type GroupedTaskLayoutRects = Map<
  string,
  {
    height: number;
    left: number;
    top: number;
  }
>;

export const GROUPED_TASK_DROP_ANIMATION: DropAnimation = {
  duration: 150,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};
export const GROUPED_TASK_AUTO_SCROLL_THRESHOLD = {
  x: 0.1,
  y: 0.1,
} as const;

export function collectGroupedTaskLayoutRects(root: HTMLElement | null): GroupedTaskLayoutRects {
  const rects: GroupedTaskLayoutRects = new Map();
  if (!root) {
    return rects;
  }
  root.querySelectorAll<HTMLElement>("[data-grouped-layout-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-layout-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`layout:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  root.querySelectorAll<HTMLElement>("[data-grouped-task-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-task-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`task:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  return rects;
}

export function measureGroupedTaskPreviewWidth(
  root: HTMLElement | null,
  targetTaskKey: string,
): number | null {
  if (!root) {
    return null;
  }
  const targetDomKey = encodeURIComponent(targetTaskKey);
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-task-key]")) {
    if (element.getAttribute("data-grouped-task-key") === targetDomKey) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

export function measureGroupedGroupPreviewWidth(
  root: HTMLElement | null,
  targetGroupId: string,
): number | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    if (element.getAttribute("data-grouped-group-item-id") === targetGroupId) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

export function resolveStickyGroupedTaskGroupId(root: HTMLElement | null): string | null {
  if (!root) {
    return null;
  }
  const scrollContainer = findNearestScrollableAncestor(root);
  if (!scrollContainer) {
    return null;
  }
  const containerTop = scrollContainer.getBoundingClientRect().top;
  let stickyGroupId: string | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    const groupId = element.getAttribute("data-grouped-group-item-id");
    if (element.getAttribute("data-group-collapsed") === "true") {
      continue;
    }
    const header = groupId
      ? root.querySelector<HTMLElement>(`[data-grouped-group-header-id="${CSS.escape(groupId)}"]`)
      : null;
    if (!groupId || !header) {
      continue;
    }
    const groupRect = element.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const headerHeight = headerRect.height || 32;
    const headerHasScrolledPastTop = headerRect.top < containerTop - 0.5;
    const groupStillCoversTop = groupRect.bottom > containerTop + headerHeight + 0.5;
    if (headerHasScrolledPastTop && groupStillCoversTop) {
      stickyGroupId = groupId;
    }
  }
  return stickyGroupId;
}

export function animateGroupedTaskLayoutFrom(
  root: HTMLElement | null,
  previousRects: GroupedTaskLayoutRects,
) {
  if (!root || previousRects.size === 0) {
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const selector = "[data-grouped-layout-key], [data-grouped-task-key]";
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const layoutKey = element.getAttribute("data-grouped-layout-key");
    const taskKeyValue = element.getAttribute("data-grouped-task-key");
    const previousRect = layoutKey
      ? previousRects.get(`layout:${layoutKey}`)
      : taskKeyValue
        ? previousRects.get(`task:${taskKeyValue}`)
        : null;
    if (!previousRect) {
      return;
    }
    const nextRect = element.getBoundingClientRect();
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    const deltaHeight = previousRect.height - nextRect.height;
    const shouldAnimateHeight = Boolean(layoutKey) && Math.abs(deltaHeight) >= 0.5;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && !shouldAnimateHeight) {
      return;
    }
    element.getAnimations().forEach((animation) => animation.cancel());
    const previousOverflow = element.style.overflow;
    if (shouldAnimateHeight) {
      element.style.overflow = "hidden";
    }
    const animation = element.animate(
      [
        {
          height: shouldAnimateHeight ? `${previousRect.height}px` : undefined,
          transform: `translate(${deltaX}px, ${deltaY}px)`,
        },
        {
          height: shouldAnimateHeight ? `${nextRect.height}px` : undefined,
          transform: "translate(0, 0)",
        },
      ],
      {
        duration: 150,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      },
    );
    animation.addEventListener(
      "finish",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
    animation.addEventListener(
      "cancel",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
  });
}
