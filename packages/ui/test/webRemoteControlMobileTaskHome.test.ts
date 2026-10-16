import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import {
  WebRemoteControlMobileTaskHome,
  buildWebRemoteControlMobileTaskHomeModel,
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
} from "@/WebRemoteControlMobileTaskHome.js";
import { hasWebRemoteControlMobileTaskHomeActiveTaskMatch } from "@/lib/webRemoteControlMobileTaskHome.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    selector: (state: { theme: string; setTheme: (theme: string) => void }) => unknown,
  ) => selector({ theme: "dark", setTheme: vi.fn() }),
}));

const defaultPreferences = {
  organizeBy: "workspace" as const,
  sortBy: "updated" as const,
};

function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  // 修复原因：移动端 timeline 复用本地自然日分组；测试用本地时间构造，
  // 避免海外 runner 把 +08:00 的今天任务归到昨天。
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function createStorageMock(initial: Record<string, string> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => state.get(key) ?? null,
    setItem: (key: string, value: string) => {
      state.set(key, value);
    },
    removeItem: (key: string) => {
      state.delete(key);
    },
  };
}

const workspaceList: WebRemoteControlWorkspaceListResult = {
  activeTaskId: "remote-task",
  activeWorkspaceKey: "ssh://dev/workspace/remote",
  workspaces: [
    {
      workspacePath: "/workspace/local",
      label: "Local App",
      kind: "local",
    },
    {
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://dev/workspace/remote",
      remoteSessionId: "remote-session",
      label: "Remote App",
      kind: "remote",
    },
  ],
  tasks: [
    {
      taskId: "remote-task",
      title: "Remote task",
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://dev/workspace/remote",
      remoteSessionId: "remote-session",
      workspaceLabel: "Remote App",
      workspaceKind: "remote",
      createdAt: 1,
      updatedAt: 20,
      provider: "codex",
      displayStatus: "running",
    },
    {
      taskId: "local-task",
      title: "Local task",
      workspacePath: "/workspace/local",
      workspaceLabel: "Local App",
      workspaceKind: "local",
      createdAt: 1,
      updatedAt: 10,
      displayStatus: "completed",
    },
  ] satisfies WebRemoteControlTaskTarget[],
};

describe("WebRemoteControlMobileTaskHome", () => {
  it("does not register automatic workspace list polling", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlMobileTaskHome.tsx"),
      "utf8",
    );

    expect(source).not.toContain("setInterval");
  });

  it("groups tasks by desktop workspace order and expands the active workspace", () => {
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      result: workspaceList,
    });

    expect(model.groups.map((group) => group.workspace.label)).toEqual(["Local App", "Remote App"]);
    expect([...model.defaultExpandedWorkspaceKeys]).toEqual(["ssh://dev/workspace/remote"]);
    expect(model.activeTaskId).toBe("remote-task");
    expect(model.totalTaskCount).toBe(2);
  });

  it("shows the aggregate unread dot only on collapsed workspace cards", () => {
    const result = {
      ...workspaceList,
      tasks: workspaceList.tasks?.map((task) =>
        task.taskId === "local-task" ? { ...task, unreadAt: 123 } : task,
      ),
    };
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      result,
    });
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlMobileTaskHome, {
        activeTaskId: null,
        activeWorkspacePath: "/workspace/local",
        initialResult: result,
        preferences: defaultPreferences,
        onPreferencesChange: vi.fn(),
        onOpenTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => result),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    );

    expect(model.groups.find((group) => group.workspace.label === "Local App")?.hasUnread).toBe(
      true,
    );
    expect(html.match(/data-workspace-unread-indicator="true"/g)).toHaveLength(1);
  });

  it("builds timeline tasks across workspaces by the selected time field", () => {
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      sortBy: "created",
      result: {
        ...workspaceList,
        tasks: [
          {
            ...workspaceList.tasks![0],
            taskId: "older-created",
            createdAt: 10,
            updatedAt: 100,
            displayStatus: "completed",
          },
          {
            ...workspaceList.tasks![1],
            taskId: "newer-created",
            createdAt: 20,
            updatedAt: 1,
            displayStatus: "completed",
          },
        ],
      },
    });

    expect(model.timelineTasks.map((task) => task.taskId)).toEqual([
      "newer-created",
      "older-created",
    ]);
  });

  it("手机 workspace/timeline 列表复用 running 两层排序", () => {
    const base = workspaceList.tasks![1] as WebRemoteControlTaskTarget;
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      sortBy: "updated",
      result: {
        ...workspaceList,
        tasks: [
          {
            ...base,
            taskId: "parent",
            createdAt: 10,
            updatedAt: 1_000,
            displayStatus: "running",
          },
          {
            ...base,
            taskId: "fork",
            createdAt: 20,
            updatedAt: 1,
            displayStatus: "running",
          },
          {
            ...base,
            taskId: "completed",
            createdAt: 30,
            updatedAt: 2_000,
            displayStatus: "completed",
          },
        ],
      },
    });

    const expected = ["fork", "parent", "completed"];
    expect(model.timelineTasks.map((task) => task.taskId)).toEqual(expected);
    expect(model.groups[0]?.tasks.map((task) => task.taskId)).toEqual(expected);
  });

  it("手机列表把有后台工作的会话并入运行层，不随 updatedAt 交替换位", () => {
    const base = workspaceList.tasks![1] as WebRemoteControlTaskTarget;
    const build = (aUpdatedAt: number, bUpdatedAt: number) =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId: null,
        activeWorkspacePath: "/workspace/local",
        sortBy: "updated",
        result: {
          ...workspaceList,
          tasks: [
            {
              ...base,
              taskId: "run-a",
              createdAt: 10,
              updatedAt: aUpdatedAt,
              displayStatus: "completed",
              hasBackgroundWork: true,
            },
            {
              ...base,
              taskId: "run-b",
              createdAt: 20,
              updatedAt: bUpdatedAt,
              displayStatus: "completed",
              hasBackgroundWork: true,
            },
            {
              ...base,
              taskId: "idle",
              createdAt: 30,
              updatedAt: 5_000,
              displayStatus: "completed",
            },
          ],
        },
      });

    const expected = ["run-b", "run-a", "idle"];
    expect(build(900, 100).timelineTasks.map((task) => task.taskId)).toEqual(expected);
    expect(build(100, 900).timelineTasks.map((task) => task.taskId)).toEqual(expected);
    expect(build(100, 900).groups[0]?.tasks.map((task) => task.taskId)).toEqual(expected);
  });

  it("renders desktop timeline group labels in mobile timeline mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(localTimestamp(2026, 5, 21, 12, 0)));
    try {
      const html = renderToStaticMarkup(
        createElement(WebRemoteControlMobileTaskHome, {
          activeTaskId: null,
          activeWorkspacePath: "/workspace/local",
          initialResult: {
            ...workspaceList,
            tasks: [
              {
                ...workspaceList.tasks![0],
                taskId: "today-task",
                title: "Today task",
                updatedAt: localTimestamp(2026, 5, 21, 9, 0),
              },
              {
                ...workspaceList.tasks![1],
                taskId: "last-month-task",
                title: "Last month task",
                updatedAt: localTimestamp(2026, 4, 20, 9, 0),
              },
            ],
          },
          preferences: { organizeBy: "timeline", sortBy: "updated" },
          onPreferencesChange: vi.fn(),
          onOpenTask: vi.fn(),
          switcher: {
            listWorkspaces: vi.fn(async () => workspaceList),
            switchWorkspace: vi.fn(async () => {}),
          },
        }),
      );

      expect(html).toContain("taskTimeline.today");
      expect(html).toContain("taskTimeline.lastMonth");
      expect(html.indexOf("taskTimeline.today")).toBeLessThan(html.indexOf("Today task"));
      expect(html.indexOf("taskTimeline.lastMonth")).toBeLessThan(
        html.indexOf("Last month task"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates pinned tasks from regular mobile task groups", () => {
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      result: {
        ...workspaceList,
        tasks: [
          {
            ...workspaceList.tasks![0],
            taskId: "pinned-remote",
            pinned: true,
            updatedAt: 30,
          },
          {
            ...workspaceList.tasks![1],
            taskId: "regular-local",
            updatedAt: 20,
          },
        ],
      },
    });

    expect(model.pinnedTasks.map((task) => task.taskId)).toEqual(["pinned-remote"]);
    expect(model.timelineTasks.map((task) => task.taskId)).toEqual(["regular-local"]);
    expect(model.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-local",
    ]);
    expect(model.totalTaskCount).toBe(2);
  });

  it("keeps archived tasks out of regular mobile task groups and timeline", () => {
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      result: {
        ...workspaceList,
        tasks: [
          {
            ...workspaceList.tasks![0],
            taskId: "archived-remote",
            archived: true,
            updatedAt: 30,
          },
          {
            ...workspaceList.tasks![1],
            taskId: "regular-local",
            updatedAt: 20,
          },
        ],
      },
    });

    expect(model.pinnedTasks).toEqual([]);
    expect(model.timelineTasks.map((task) => task.taskId)).toEqual(["regular-local"]);
    expect(model.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-local",
    ]);
    expect(model.totalTaskCount).toBe(1);
  });

  it("treats an active pinned task as matched even though it is outside workspace groups", () => {
    const model = buildWebRemoteControlMobileTaskHomeModel({
      activeTaskId: null,
      activeWorkspacePath: "/workspace/local",
      result: {
        ...workspaceList,
        activeTaskId: "pinned-remote",
        tasks: [
          {
            ...workspaceList.tasks![0],
            taskId: "pinned-remote",
            pinned: true,
            updatedAt: 30,
          },
        ],
      },
    });

    expect(hasWebRemoteControlMobileTaskHomeActiveTaskMatch(model)).toBe(true);
  });

  it("persists mobile task home preferences across page refreshes", () => {
    const storage = createStorageMock();

    persistWebRemoteControlMobileTaskHomePreferences(
      { organizeBy: "timeline", sortBy: "created" },
      storage,
    );

    expect(readWebRemoteControlMobileTaskHomePreferences(storage)).toEqual({
      organizeBy: "timeline",
      sortBy: "created",
    });
  });

  it("renders selected task rows and task display status pills", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlMobileTaskHome, {
        activeTaskId: null,
        activeWorkspacePath: "/workspace/local",
        initialResult: workspaceList,
        preferences: defaultPreferences,
        onPreferencesChange: vi.fn(),
        onOpenTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => workspaceList),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    );

    expect(html).toContain("Remote App");
    expect(html).toContain("Remote task");
    expect(html).toContain('data-state="selected"');
    expect(html).toContain("webRemoteControl.taskStatus.running");
  });

  it("renders a theme menu trigger in the mobile task list header", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlMobileTaskHome, {
        activeTaskId: null,
        activeWorkspacePath: "/workspace/local",
        initialResult: workspaceList,
        preferences: defaultPreferences,
        onPreferencesChange: vi.fn(),
        onOpenTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => workspaceList),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    );

    expect(html).toContain("webRemoteControl.themeMenu.trigger");
  });

  it("renders disconnected remote workspaces with a reconnect action", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlMobileTaskHome, {
        activeTaskId: null,
        activeWorkspacePath: "/workspace/local",
        initialResult: {
          workspaces: [
            {
              workspacePath: "/workspace/remote",
              workspaceIdentity: "ssh://dev/workspace/remote",
              label: "Remote App",
              kind: "remote",
              connectionState: "disconnected",
              lastConnectionError: "ssh closed",
            },
          ],
          tasks: [],
        },
        preferences: defaultPreferences,
        onPreferencesChange: vi.fn(),
        onOpenTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => workspaceList),
          switchWorkspace: vi.fn(async () => {}),
          reconnectWorkspace: vi.fn(async () => {}),
        },
      }),
    );

    expect(html).toContain("Remote App");
    expect(html).toContain("webRemoteControl.mobileHome.disconnected");
    expect(html).toContain("webRemoteControl.mobileHome.reconnect");
    expect(html).toContain("ssh closed");
  });
});
