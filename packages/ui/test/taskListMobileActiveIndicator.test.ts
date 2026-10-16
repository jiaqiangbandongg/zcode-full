import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { MemoTaskItem as TaskItem } from "@/TaskListItem.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const { workspaceStateByPath } = vi.hoisted(() => ({
  workspaceStateByPath: new Map<string, unknown>(),
}));

vi.mock("@/store/zcodeSessionStore.js", async () => {
  const actual = await vi.importActual<typeof import("@/store/zcodeSessionStore.js")>(
    "@/store/zcodeSessionStore.js",
  );
  return {
    ...actual,
    useZCodeSessionStore: (selector: (state: { workspaces: Record<string, unknown> }) => unknown) =>
      selector({ workspaces: Object.fromEntries(workspaceStateByPath) }),
  };
});

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskProvider: "codex",
    taskSessionFile: { loading: false, path: null, exists: false },
    taskNativeSessionLogFile: { loading: false, path: null, exists: false },
    providerConfigFile: { loading: false, path: null, exists: false },
    fileManagerLabel: "Open in Finder",
    handleCopyText: async () => {},
    handleOpenTaskPathInFileManager: async () => {},
    handleOpenProviderConfig: async () => {},
  }),
}));

beforeEach(() => {
  workspaceStateByPath.clear();
});

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "mobile-active-task",
    traceId: "trace-mobile-active-task",
    title: "手机正在查看的任务",
    workspacePath: "/tmp/workspace-mobile-active",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function createIntl() {
  return {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "taskList.mobileActive": "手机正在操作此任务",
        "taskList.permissionTag": "等待确认",
        "taskList.stopCountdown": "停止计时",
        "taskList.untitled": "新对话",
        "taskList.justNow": "刚刚",
        "taskList.minutesAgo": "{minutes}分",
        "taskList.hoursAgo": "{hours}小时",
        "taskList.daysAgo": "{days}天",
        "taskList.archive": "归档任务",
        "common.confirm": "确认",
      };
      let message = messages[id] ?? id;
      if (values) {
        Object.entries(values).forEach(([key, value]) => {
          message = message.replaceAll(`{${key}}`, value);
        });
      }
      return message;
    },
  };
}

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

function renderTaskItem({
  task = createTaskMeta(),
  isPinned = false,
  isMobileActive = true,
  legacyUnread = Boolean(task.unreadAt),
}: {
  task?: ZCodeTaskMeta;
  isPinned?: boolean;
  isMobileActive?: boolean;
  legacyUnread?: boolean;
} = {}) {
  workspaceStateByPath.set(task.workspacePath, {
    taskRuntimeByTaskId: {
      [task.taskId]: {
        status: "completed",
        error: null,
        usage: null,
      },
    },
    taskUiByTaskId: {
      [task.taskId]: {
        permissionRequest: null,
        pendingPermissionRequests: [],
      },
    },
    taskUnreadByTaskId: legacyUnread ? { [task.taskId]: true } : {},
  });

  return renderWithTooltipProvider(
    createElement(TaskItem, {
      workspacePath: task.workspacePath,
      task,
      isPinned,
      isActive: false,
      isMobileActive,
      onSelectTask: () => {},
      onArchiveTaskInline: () => {},
      onCancelArchiveConfirm: () => {},
      isArchiveConfirming: false,
      intl: createIntl(),
    }),
  );
}

describe("TaskList mobile active indicator", () => {
  it("shows a phone marker on the desktop task row that is open on mobile", () => {
    const html = renderTaskItem();

    expect(html).toContain('data-mobile-active-task="true"');
    expect(html).toContain("手机正在操作此任务");
  });

  it("renders unread dot with sky colors", () => {
    const html = renderTaskItem({
      task: createTaskMeta({ unreadAt: 100 }),
      isMobileActive: false,
      legacyUnread: false,
    });

    expect(html).toContain('data-unread-indicator="true"');
    expect(html).toContain("bg-sky-500");
    expect(html).toContain("dark:bg-sky-400");
    expect(html).not.toContain("bg-brand");
  });

  it("renders error dot from task meta status", () => {
    const html = renderTaskItem({
      task: createTaskMeta({ status: "error", unreadAt: 100 }),
      isMobileActive: false,
      legacyUnread: false,
    });

    expect(html).toContain('data-error-indicator="true"');
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain('data-unread-indicator="true"');
  });

  it("places the phone marker before the task title text", () => {
    const html = renderTaskItem();

    expect(html.indexOf('aria-label="手机正在操作此任务"')).toBeLessThan(
      html.indexOf('data-task-title-copy="original"'),
    );
    expect(html).not.toContain('title="手机正在查看的任务"');
  });

  it("keeps the phone marker out of the title flex flow", () => {
    const html = renderTaskItem();

    expect(html).toMatch(
      /<span data-mobile-active-task="true" class="[^"]*absolute[^"]*" aria-label="手机正在操作此任务" data-state="closed" data-slot="tooltip-trigger">/,
    );
  });

  it("keeps the phone marker mounted until React interaction state replaces it", () => {
    const html = renderTaskItem();

    expect(html).toMatch(
      /<span data-mobile-active-task="true"[^>]*aria-label="手机正在操作此任务"[^>]*data-slot="tooltip-trigger">/,
    );
    expect(html).not.toContain("group-hover/task-item:hidden");
    expect(html).not.toContain('aria-label="taskList.pin"');
  });

  it("does not mount unpin until interaction when the phone marker owns the leading slot", () => {
    const html = renderTaskItem({ isPinned: true });

    expect(html).toMatch(
      /<span data-mobile-active-task="true"[^>]*aria-label="手机正在操作此任务"[^>]*data-slot="tooltip-trigger">/,
    );
    expect(html).not.toContain('aria-label="taskList.unpin"');
  });
});
