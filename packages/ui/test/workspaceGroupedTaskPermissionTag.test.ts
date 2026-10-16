import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/workspace-grouped-tasks/task-row.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const messages: Record<string, string> = {
          "common.close": "关闭",
          "git.action.showTree": "显示文件树",
          "taskList.feedbackOpened": "已打开反馈",
          "taskList.justNow": "刚刚",
          "taskList.permissionTag": "等待确认",
          "taskList.userInputTag": "等待确认",
          "taskList.stopCountdown": "停止计时",
          "taskList.attentionCount": "{label} ×{count}",
          "taskList.cronTaskLabel": "定时任务",
          "taskList.untitled": "新对话",
        };
        let message = messages[id] ?? id;
        if (values) {
          Object.entries(values).forEach(([key, value]) => {
            message = message.replaceAll(`{${key}}`, value);
          });
        }
        return message;
      },
    },
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => undefined,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
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
    taskId: "grouped-task-permission",
    traceId: "trace-grouped-task-permission",
    title: "Grouped 等待确认",
    workspacePath: "/tmp/workspace-grouped-task-permission",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function renderGroupedTaskRow(
  params: {
    task?: Partial<ZCodeTaskMeta>;
    unreadAt?: number;
    permissionCount?: number;
    userInputCount?: number;
    phase?: "running" | "completedSuccess";
  } = {},
) {
  const task = attachTaskListRowActivity(
    createTaskMeta({
      ...(params.unreadAt ? { unreadAt: params.unreadAt } : {}),
      ...params.task,
    }),
    {
      phase: params.phase ?? "running",
      lastActivityAt: 10,
      hasBackgroundWork: false,
      pendingInteractions: {
        permissionCount: params.permissionCount ?? 1,
        userInputCount: params.userInputCount ?? 0,
      },
    },
  );

  return renderToStaticMarkup(
    createElement(GroupedTaskRow, {
      task,
      groups: [],
      activeWorkspacePath: task.workspacePath,
      activeWorkspaceIdentity: task.workspaceIdentity,
      activeTaskId: null,
      workspaceLabel: "workspace",
      onSelectTask: () => {},
      onCloseTask: () => {},
      onMoveTaskToGroup: () => {},
      onMoveTaskToTop: () => {},
      onStartRenameTask: () => {},
      onArchiveTask: () => {},
      onMarkTaskAsUnread: () => {},
    }),
  );
}

describe("GroupedTaskRow pending interaction tag", () => {
  it("把权限等待渲染为 pill badge", () => {
    const html = renderGroupedTaskRow({
      task: { updatedAt: Date.now() },
      phase: "completedSuccess",
    });

    expect(html).toContain("等待确认");
    expect(html).not.toContain("刚刚");
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain("rounded-full");
  });

  it("sessions-index 权限胶囊出现时隐藏相对时间", () => {
    const html = renderGroupedTaskRow({
      task: {
        updatedAt: Date.now(),
        pendingInteraction: {
          interactionId: "permission-summary",
          kind: "permission",
        },
      },
      permissionCount: 0,
      userInputCount: 0,
      phase: "completedSuccess",
    });

    expect(html).toContain("等待确认");
    expect(html).not.toContain("刚刚");
  });

  it("用户问答统一使用等待确认语义", () => {
    const html = renderGroupedTaskRow({
      permissionCount: 0,
      userInputCount: 1,
    });

    expect(html).toContain("等待确认");
    expect(html).toContain('data-slot="badge"');
  });

  it("renders sessions-index AskUserQuestion with the shared user-input pill", () => {
    const html = renderGroupedTaskRow({
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
    });

    expect(html).toContain("等待确认");
    expect(html).toContain('data-task-interaction-badge="userInput"');
    expect(html).toContain("bg-interaction-confirmation-surface");
  });

  it("使用与普通任务列表相同的 sky 未读点", () => {
    const html = renderGroupedTaskRow({
      unreadAt: 100,
      permissionCount: 0,
    });

    expect(html).toContain("bg-sky-500");
    expect(html).toContain("dark:bg-sky-400");
    expect(html).not.toContain("bg-brand");
  });

  it("定时任务在未读状态下仍把 clock 放在时间前面", () => {
    const html = renderGroupedTaskRow({
      task: {
        cronAutomationId: "automation-1",
        updatedAt: Date.now(),
      },
      unreadAt: 100,
      permissionCount: 0,
      phase: "completedSuccess",
    });

    expect(html).toContain("bg-sky-500");
    expect(html).toContain('data-cron-task-icon="true"');
    expect(html).toContain('aria-label="定时任务"');
    expect(html).toContain("刚刚");
  });
});
