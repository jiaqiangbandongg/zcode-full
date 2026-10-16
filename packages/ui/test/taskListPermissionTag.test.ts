import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { MemoTaskItem as TaskItem } from "@/TaskListItem.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

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

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-permission",
    traceId: "trace-permission",
    title: "等待确认命令执行",
    workspacePath: "/tmp/workspace-task-permission-tag",
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
        "taskList.userInputTag": "等待确认",
        "taskList.stopCountdown": "停止计时",
        "taskList.attentionCount": "{label} ×{count}",
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

function renderTaskItem(
  params: {
    task?: Partial<ZCodeTaskMeta>;
    permissionCount?: number;
    userInputCount?: number;
    variant?: "default" | "timeline";
  } = {},
) {
  const permissionCount = params.permissionCount ?? 1;
  const userInputCount = params.userInputCount ?? 0;
  const task = attachTaskListRowActivity(createTaskMeta(params.task), {
    phase: "running",
    lastActivityAt: 10,
    hasBackgroundWork: false,
    pendingInteractions: { permissionCount, userInputCount },
  });

  return renderToStaticMarkup(
    createElement(TaskItem, {
      workspacePath: task.workspacePath,
      task,
      isPinned: false,
      isActive: false,
      onSelectTask: () => {},
      onArchiveTaskInline: () => {},
      onCancelArchiveConfirm: () => {},
      isArchiveConfirming: false,
      variant: params.variant,
      onTogglePinTask: () => {},
      onStartRenameTask: () => {},
      onArchiveTask: () => {},
      onMarkTaskAsUnread: () => {},
      intl: createIntl(),
    }),
  );
}

describe("TaskList pending interaction tag", () => {
  it("权限请求会显示标题右侧 tag，但不会额外渲染未读蓝点", () => {
    const html = renderTaskItem({ task: { updatedAt: Date.now() } });

    expect(html).toContain("等待确认");
    expect(html).not.toContain("刚刚");
    expect(html).not.toContain('data-unread-indicator="true"');
    expect(html).not.toContain('data-testid="task-archive-task-permission"');
  });

  it.each(["default", "timeline"] as const)(
    "sessions-index 权限胶囊在 %s row 出现时隐藏相对时间",
    (variant) => {
      const html = renderTaskItem({
        task: {
          updatedAt: Date.now(),
          pendingInteraction: {
            interactionId: "permission-summary",
            kind: "permission",
          },
        },
        permissionCount: 0,
        userInputCount: 0,
        variant,
      });

      expect(html).toContain("等待确认");
      expect(html).not.toContain("刚刚");
    },
  );

  it("用户问答请求统一使用等待确认语义，并显示合并数量", () => {
    const html = renderTaskItem({ permissionCount: 1, userInputCount: 2 });

    expect(html).toContain("等待确认 ×3");
    expect(html).not.toContain('data-unread-indicator="true"');
  });

  it.each(["default", "timeline"] as const)(
    "sessions-index AskUserQuestion 在 %s row 显示专用胶囊",
    (variant) => {
      const html = renderTaskItem({
        task: {
          pendingInteraction: {
            interactionId: "ask-summary",
            kind: "userInput",
            toolName: "AskUserQuestion",
            autoResolution: {
              state: "snoozed",
              startedAt: 1,
              snoozedAt: 2,
            },
          },
        },
        permissionCount: 0,
        userInputCount: 0,
        variant,
      });

      expect(html).toContain("等待确认");
      expect(html).toContain('data-task-interaction-badge="userInput"');
      expect(html).toContain("bg-interaction-confirmation-surface");
      expect(html).not.toContain("data-countdown-progress=");
    },
  );
});
