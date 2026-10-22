// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";

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

  // Web 与桌面统一使用 ArchiveManagement；批次身份与软删除见 archiveManagement.test.ts。
});
