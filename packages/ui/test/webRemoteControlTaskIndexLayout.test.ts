import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

function createTestServices() {
  return {
    zcodeTaskService: {
      archiveTask: vi.fn(),
      setTaskPinned: vi.fn(),
    },
  };
}

async function renderTaskIndex() {
  const { WebRemoteControlTaskIndex } = await import("@/WebRemoteControlTaskIndex.js");

  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: createTestServices() as never },
      createElement(WebRemoteControlTaskIndex, {
        activeTaskId: null,
        activeWorkspacePath: "/tmp/project",
        onSelectTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    ),
  );
}

async function renderTaskIndexWithInitialTasks() {
  const { WebRemoteControlTaskIndex } = await import("@/WebRemoteControlTaskIndex.js");
  const TaskIndex = WebRemoteControlTaskIndex as ComponentType<Record<string, unknown>>;

  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: createTestServices() as never },
      createElement(TaskIndex, {
        activeTaskId: null,
        activeWorkspacePath: "/tmp/project",
        initialResult: {
          workspaces: [
            {
              workspacePath: "/tmp/project",
              label: "Project",
              kind: "local",
            },
          ],
          tasks: [
            {
              taskId: "task-1",
              title: "Task one",
              workspacePath: "/tmp/project",
              workspaceLabel: "Project",
              workspaceKind: "local",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
        onSelectTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    ),
  );
}

async function renderCollapsedTaskIndexWithUnread() {
  const { WebRemoteControlTaskIndex } = await import("@/WebRemoteControlTaskIndex.js");
  const TaskIndex = WebRemoteControlTaskIndex as ComponentType<Record<string, unknown>>;

  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: createTestServices() as never },
      createElement(TaskIndex, {
        activeTaskId: null,
        activeWorkspacePath: "/tmp/project",
        collapsedWorkspaceKeys: new Set(["/tmp/project"]),
        initialResult: {
          workspaces: [{ workspacePath: "/tmp/project", label: "Project", kind: "local" }],
          tasks: [
            {
              taskId: "task-unread",
              title: "Unread task",
              workspacePath: "/tmp/project",
              workspaceLabel: "Project",
              workspaceKind: "local",
              createdAt: 1,
              updatedAt: 2,
              unreadAt: 123,
            },
          ],
        },
        onSelectTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
          switchWorkspace: vi.fn(async () => {}),
        },
        taskViewMode: "workspace",
      }),
    ),
  );
}

async function renderTaskIndexWithInitialPinnedTasks() {
  const { WebRemoteControlTaskIndex } = await import("@/WebRemoteControlTaskIndex.js");
  const TaskIndex = WebRemoteControlTaskIndex as ComponentType<Record<string, unknown>>;

  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: createTestServices() as never },
      createElement(TaskIndex, {
        activeTaskId: null,
        activeWorkspacePath: "/tmp/project",
        initialResult: {
          workspaces: [
            {
              workspacePath: "/tmp/project",
              label: "Project",
              kind: "local",
            },
          ],
          tasks: [
            {
              taskId: "task-1",
              title: "Pinned task",
              workspacePath: "/tmp/project",
              workspaceLabel: "Project",
              workspaceKind: "local",
              createdAt: 1,
              updatedAt: 2,
              pinned: true,
            },
          ],
        },
        onSelectTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
          switchWorkspace: vi.fn(async () => {}),
        },
      }),
    ),
  );
}

async function renderTaskIndexWithInitialArchivedTasks(hasTasks = true) {
  const { WebRemoteControlTaskIndex } = await import("@/WebRemoteControlTaskIndex.js");
  const TaskIndex = WebRemoteControlTaskIndex as ComponentType<Record<string, unknown>>;

  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: createTestServices() as never },
      createElement(TaskIndex, {
        activeTaskId: null,
        activeWorkspacePath: "/tmp/project",
        initialResult: {
          workspaces: [
            {
              workspacePath: "/tmp/project",
              label: "Project",
              kind: "local",
            },
          ],
          tasks: hasTasks
            ? [
                {
                  taskId: "task-1",
                  title: "Archived task",
                  workspacePath: "/tmp/project",
                  workspaceLabel: "Project",
                  workspaceKind: "local",
                  createdAt: 1,
                  updatedAt: 2,
                  archived: true,
                  pinned: true,
                },
              ]
            : [],
        },
        onSelectTask: vi.fn(),
        switcher: {
          listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
          switchWorkspace: vi.fn(async () => {}),
        },
        taskViewMode: "archived",
      }),
    ),
  );
}

describe("WebRemoteControlTaskIndex layout", () => {
  it("does not own the mobile navigation collapse or scroll viewport", async () => {
    const html = await renderTaskIndex();

    expect(html).toContain("webRemoteControl.noTasks");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("webRemoteControl.collapseTasks");
    expect(html).not.toContain("overflow-y-auto");
  });

  it("binds desktop task index loading to active remote workspace transitions", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlTaskIndex.tsx"),
      "utf8",
    );

    expect(source).toContain("shouldRetryWebRemoteControlTaskIndexLoad");
    expect(source).toContain(
      "}, [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher]);",
    );
  });

  it("lets the wide remote sidebar render its workspace toolbar after pinned tasks", () => {
    const taskIndexSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlTaskIndex.tsx"),
      "utf8",
    );
    const sidebarSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"),
      "utf8",
    );

    expect(taskIndexSource).toContain("renderBeforePinnedTasks");
    expect(taskIndexSource).toContain("model.pinnedTasks.map((task) => renderTaskRow(task))");
    expect(
      taskIndexSource.indexOf("{renderBeforePinnedTasks ? renderBeforePinnedTasks() : null}"),
    ).toBeLessThan(taskIndexSource.indexOf("{model.pinnedTasks.length > 0 ? ("));
    expect(sidebarSource).toContain("const workspaceTaskToolbar");
    expect(sidebarSource).toContain("renderBeforePinnedTasks={workspaceTaskToolbar}");
    expect(sidebarSource).toContain("{!isWebRemoteControlSidebar ? workspaceTaskToolbar() : null}");
  });

  it("keeps mutable wide remote task actions out of the initial static markup", async () => {
    const html = await renderTaskIndexWithInitialTasks();

    expect(html).toContain('data-web-remote-task-row="/tmp/project:task-1"');
    expect(html).not.toContain('aria-label="taskList.pin"');
    expect(html).not.toContain('aria-label="taskList.archive"');
  });

  it("renders the aggregate unread dot on a collapsed wide workspace row", async () => {
    const html = await renderCollapsedTaskIndexWithUnread();

    expect(html).toContain('data-workspace-unread-indicator="true"');
    expect(html).not.toContain("Unread task");
  });

  it("keeps archived wide remote rows aligned with desktop archived actions", async () => {
    const html = await renderTaskIndexWithInitialArchivedTasks();

    expect(html).toContain("Archived task");
    expect(html).not.toContain('aria-label="taskList.pin"');
    expect(html).not.toContain('aria-label="taskList.unpin"');
    expect(html).not.toContain('aria-label="taskList.archive"');
    expect(html).not.toContain("lucide-pin");
  });

  it("renders wide remote task rows with button semantics for opening tasks", async () => {
    const html = await renderTaskIndexWithInitialTasks();

    expect(html).toMatch(
      /<button(?=[^>]*aria-label="webRemoteControl\.openTask")[^>]*data-testid="task-item-task-1"/,
    );
  });

  it("keeps the pinned row unpin action out of the initial static markup", async () => {
    const html = await renderTaskIndexWithInitialPinnedTasks();

    expect(html).toContain("Pinned task");
    expect(html).toContain("lucide-pin");
    expect(html).not.toContain('aria-label="taskList.unpin"');
  });
});

describe("Web 归档批量删除入口", () => {
  it("归档态提供共享入口，空态禁用，普通视图不显示", async () => {
    const populated = await renderTaskIndexWithInitialArchivedTasks();
    expect(populated).toContain('data-testid="archived-tasks-actions"');
    expect(populated).toContain('aria-label="taskList.archivedActions"');
    expect(populated).not.toContain('data-testid="delete-all-archived-tasks"');
    const empty = await renderTaskIndexWithInitialArchivedTasks(false);
    expect(empty).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*data-testid="archived-tasks-actions")/);
    expect(await renderTaskIndex()).not.toContain('data-testid="archived-tasks-actions"');
  });
});
