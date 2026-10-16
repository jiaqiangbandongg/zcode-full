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
    taskId: "task-change-summary",
    traceId: "trace-change-summary",
    title: "汇总任务文件改动",
    workspacePath: "/repo/workspace",
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
        "taskList.permissionTag": "等待确认",
        "taskList.stopCountdown": "停止计时",
        "taskList.untitled": "新对话",
        "taskList.justNow": "刚刚",
        "taskList.minutesAgo": "{minutes}分",
        "taskList.hoursAgo": "{hours}小时",
        "taskList.daysAgo": "{days}天",
        "taskList.archive": "归档任务",
        "taskList.changeStats": "+{added} -{removed}",
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

function renderTaskItem(
  task: ZCodeTaskMeta = createTaskMeta({
    changeSummary: {
      fileCount: 2,
      added: 8,
      removed: 3,
      files: [
        {
          path: "/repo/workspace/packages/ui/src/TaskList.tsx",
          added: 5,
          removed: 2,
          writeCount: 2,
          lastTurnIndex: 1,
        },
        {
          path: "/repo/workspace/packages/ui/src/App.tsx",
          added: 3,
          removed: 1,
          writeCount: 1,
          lastTurnIndex: 1,
        },
      ],
    },
  }),
  props: Partial<Parameters<typeof TaskItem>[0]> = {},
) {
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
    taskUnreadByTaskId: {},
  });

  return renderWithTooltipProvider(
    createElement(TaskItem, {
      workspacePath: task.workspacePath,
      task,
      isActive: false,
      onSelectTask: () => {},
      onArchiveTaskInline: () => {},
      onCancelArchiveConfirm: () => {},
      isArchiveConfirming: false,
      intl: createIntl(),
      ...props,
    }),
  );
}

describe("TaskList change summary", () => {
  it("任务标题右侧只显示总增删，不再显示文件数量和文件列表", () => {
    const html = renderTaskItem();

    expect(html).toContain("汇总任务文件改动");
    expect(html).toContain(">+8</span>");
    expect(html).toContain(">-3</span>");
    expect(html).not.toContain("2 个文件");
    expect(html).not.toContain("packages/ui/src/TaskList.tsx +5 -2");
    expect(html).not.toContain("packages/ui/src/App.tsx +3 -1");
  });

  it("timeline variant 把 workspace 和改动统计放到第二行", () => {
    const html = renderTaskItem(undefined, { variant: "timeline" });

    expect(html).toContain("汇总任务文件改动");
    expect(html).toContain("workspace");
    expect(html).toContain("+8");
    expect(html).toContain("-3");
  });

  it("timeline variant 在闲置状态显示灰点", () => {
    const html = renderTaskItem(undefined, { variant: "timeline" });
    const defaultHtml = renderTaskItem();

    expect(html).toContain('data-idle-indicator="true"');
    expect(defaultHtml).not.toContain('data-idle-indicator="true"');
  });

  it("workspace 和 timeline 标题交给运行时溢出测量，不默认挂载渐隐", () => {
    const defaultHtml = renderTaskItem();
    const timelineHtml = renderTaskItem(undefined, { variant: "timeline" });

    expect(defaultHtml).not.toContain("mask-image:linear-gradient");
    expect(timelineHtml).not.toContain("mask-image:linear-gradient");
    expect(defaultHtml).not.toContain("truncate text-ui-base text-foreground");
    expect(timelineHtml).not.toContain("truncate text-ui-base text-foreground");
  });
});
