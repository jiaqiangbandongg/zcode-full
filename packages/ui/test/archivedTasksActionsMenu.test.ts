// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";
import { WebRemoteControlTaskIndex } from "@/WebRemoteControlTaskIndex.js";
import { ServiceProvider } from "@/hooks/useServices.js";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirm }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: { count?: number }) =>
        values?.count == null ? id : `${id}:${values.count}`,
    },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount(count = 2) {
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  const service = {
    listArchivedTasks: vi.fn(async () => [{ taskId: "one" }, { taskId: "two" }] as never),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      deletedTaskIds: taskIds,
      skippedTaskIds: [],
      failedTaskIds: [],
    })),
  };
  const onDeleted = vi.fn();
  const view = render(
    createElement(DeleteAllArchivedTasksButton, {
      count,
      disabled: count === 0,
      actionsContainer: toolbar,
      workspaces: [{ workspacePath: "/project", label: "Project", service }],
      onDeleted,
    }),
  );
  return { toolbar, service, onDeleted, ...view };
}

async function openMenu(toolbar: HTMLElement) {
  fireEvent.keyDown(within(toolbar).getByRole("button", { name: "taskList.archivedActions" }), {
    key: "ArrowDown",
  });
  return screen.findByRole("menuitem", { name: "taskList.deleteAllArchivedMenu" });
}

describe("归档更多菜单", () => {
  it("入口位于工具栏，打开菜单只展示数量，不读取或删除任务", async () => {
    const { toolbar, container, service } = mount();
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    await openMenu(toolbar);
    expect(screen.getByText("taskList.archivedTaskCount:2")).toBeTruthy();
    expect(service.listArchivedTasks).not.toHaveBeenCalled();
    expect(service.deleteArchivedTasks).not.toHaveBeenCalled();
  });

  it("取消后可以重新打开；确认期间禁用入口，菜单关闭后仍展示完成结果", async () => {
    const { toolbar, container, service, onDeleted } = mount();
    confirm.mockResolvedValueOnce(false);
    fireEvent.click(await openMenu(toolbar));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(toolbar).getByRole("button").hasAttribute("disabled")).toBe(false),
    );
    expect(service.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "taskList.deleteAllArchivedTitle:2" }),
    );

    let resolveConfirm!: (value: boolean) => void;
    confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    fireEvent.click(await openMenu(toolbar));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(toolbar.querySelector("button")?.disabled).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
    resolveConfirm(true);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(2));
    expect(service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      workspaceIdentity: undefined,
      taskIds: ["one", "two"],
    });
    expect(within(container).getByRole("status").textContent).toBe(
      "taskList.deleteAllArchivedResult",
    );
    expect(within(toolbar).queryByRole("status")).toBeNull();
  });

  it("空态禁用工具栏入口", () => {
    const { toolbar, service } = mount(0);
    expect(within(toolbar).getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(service.listArchivedTasks).not.toHaveBeenCalled();
  });

  it("Web 索引通过工具栏菜单删除后移除快照任务并保留禁用入口", async () => {
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    const task = {
      taskId: "web-archived",
      title: "Web archived task",
      workspacePath: "/project",
      workspaceLabel: "Project",
      workspaceKind: "local" as const,
      createdAt: 1,
      updatedAt: 1,
      archived: true,
    };
    const result = {
      workspaces: [{ workspacePath: "/project", label: "Project", kind: "local" as const }],
      tasks: [task],
    };
    const service = {
      listArchivedTasks: vi.fn(async () => [task]),
      deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
        deletedTaskIds: taskIds,
        skippedTaskIds: [],
        failedTaskIds: [],
      })),
    };
    confirm.mockResolvedValueOnce(true);
    render(
      createElement(
        ServiceProvider,
        { services: { zcodeTaskService: service } as never },
        createElement(WebRemoteControlTaskIndex, {
          activeWorkspacePath: "/project",
          activeTaskId: null,
          taskViewMode: "archived",
          initialResult: result,
          archivedActionsContainer: toolbar,
          onSelectTask: vi.fn(),
          switcher: {
            listWorkspaces: vi.fn(async () => result),
            switchWorkspace: vi.fn(async () => {}),
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(within(toolbar).getByRole("button").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(await openMenu(toolbar));
    await waitFor(() =>
      expect(service.deleteArchivedTasks).toHaveBeenCalledWith(
        expect.objectContaining({ taskIds: ["web-archived"], workspacePath: "/project" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Web archived task")).toBeNull());
    expect(within(toolbar).getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("taskList.deleteAllArchivedResult");
  });
});
