// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { selectProjectRows, projectHasUnread } from "@/project-sidebar/view.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { toast } from "@/components/ui/toast.js";

const mocks = vi.hoisted(() => ({
  mutateTask: vi.fn(async () => null),
  removeTaskState: vi.fn(),
  rowProps: [] as Array<Record<string, any>>,
  state: {
    workspaces: { "/one": { activeTaskId: "one" }, "/two": { activeTaskId: "two" } },
    startDraft: vi.fn(),
  },
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: mocks, zcodeTaskService: {} }),
}));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => null,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: any) => unknown) =>
    select({ ...mocks.state, removeTaskState: mocks.removeTaskState }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: any) => unknown) => select({ openSettingsTab: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/TaskListItem.js", () => ({
  MemoTaskItem: (props: Record<string, any>) => {
    mocks.rowProps.push(props);
    return createElement(
      "li",
      { "data-testid": "row", "data-active": String(props.isActive) },
      props.task.title,
      createElement(
        "button",
        { onClick: () => void props.onArchiveTask(props.task.taskId) },
        "Archive",
      ),
      props.onOpenFileTree
        ? createElement("button", { onClick: () => props.onOpenFileTree(props.task) }, "Files")
        : null,
    );
  },
  TaskListItemContextMenuContent: () => null,
}));
vi.mock("@/NewTaskButtonGroup.js", () => ({ NewTaskButtonGroup: () => null }));
vi.mock("@/TaskRenameDialog.js", () => ({ TaskRenameDialog: () => null }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  title: id,
  traceId: id,
  workspacePath: `/${id}`,
  hostId: "local",
  projectId: "p",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  ...extra,
});
const project = {
  id: "p",
  hostId: "local",
  name: "Project",
  roots: [{ rootPath: "/one", isPrimary: true, position: 0 }],
  nameOverridden: true,
  deleted: false,
  pinned: false,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
const refresh = vi.fn(async () => {});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.rowProps.length = 0;
});

it("keeps running/prewarming first without reordering them as activity timestamps change", () => {
  const live = (
    id: string,
    createdAt: number,
    updatedAt: number,
    phase: "running" | "prewarming",
  ) =>
    attachTaskListRowActivity(task(id, { createdAt, updatedAt }), {
      phase,
      lastActivityAt: updatedAt,
      hasBackgroundWork: false,
    });
  const tasks = [
    task("idle", { updatedAt: 100 }),
    live("one", 2, 8, "running"),
    live("two", 3, 1, "prewarming"),
  ];
  const selection = { kind: "project" as const, projectId: "p" };
  expect(selectProjectRows({ projects: [], tasks }, selection).map((t) => t.taskId)).toEqual([
    "two",
    "one",
    "idle",
  ]);
  tasks[1] = live("one", 2, 999, "running");
  expect(selectProjectRows({ projects: [], tasks }, selection).map((t) => t.taskId)).toEqual([
    "two",
    "one",
    "idle",
  ]);
  expect(
    selectProjectRows(
      {
        projects: [],
        tasks: [
          task("a", { createdAt: 3, updatedAt: 1 }),
          task("b", { createdAt: 2, updatedAt: 9 }),
        ],
      },
      selection,
    ).map((t) => t.taskId),
  ).toEqual(["b", "a"]);
});

it("SBV03: timeline mixes pinned/running/unclassified rows by CLI time and excludes archives", () => {
  const running = attachTaskListRowActivity(task("running", { updatedAt: 2 }), {
    phase: "running",
    lastActivityAt: 999,
    hasBackgroundWork: false,
  });
  const tasks = [
    running,
    task("pinned", { pinned: true, updatedAt: 7 }),
    task("orphan", { projectId: null, updatedAt: 8 }),
    task("deleted-project", { projectId: "gone", updatedAt: 9 }),
    task("archive", { archived: true, updatedAt: 100 }),
    task("same", { workspacePath: "/same", workspaceIdentity: "ssh:b", hostId: "b", updatedAt: 5 }),
    task("same", { workspacePath: "/same", workspaceIdentity: "ssh:a", hostId: "a", updatedAt: 5 }),
  ];
  const select = (rows: ProjectTask[]) =>
    selectProjectRows({ projects: [], tasks: rows }, { kind: "timeline" });
  expect(select(tasks).map((t) => t.taskId)).toEqual([
    "deleted-project",
    "orphan",
    "pinned",
    "same",
    "same",
    "running",
  ]);
  expect(select(tasks).map((t) => t.workspaceIdentity)).toEqual(
    select([...tasks].reverse()).map((t) => t.workspaceIdentity),
  );
  expect(select(tasks.map((t) => ({ ...t, pinned: !t.pinned })))).toHaveLength(6);
});

it("SBV05: timeline rendering preserves pure ordering and 20/+20 pagination after refresh", () => {
  const tasks = Array.from({ length: 43 }, (_, i) => task(`item-${i}`, { updatedAt: i + 1 }));
  tasks[0] = attachTaskListRowActivity(tasks[0]!, {
    phase: "running",
    lastActivityAt: 1000,
    hasBackgroundWork: false,
  });
  tasks[42] = { ...tasks[42]!, pinned: true };
  const props = { tasks, kind: "timeline" as const, onSelect: vi.fn(), refresh };
  const { rerender } = render(createElement(ProjectTaskRows, props));
  expect(screen.getAllByTestId("row")).toHaveLength(20);
  expect(screen.getAllByTestId("row")[0]?.textContent).toContain("item-42");
  expect(screen.queryByText("taskList.pinnedSection")).toBeNull();
  fireEvent.click(screen.getByText("taskList.showMore"));
  expect(screen.getAllByTestId("row")).toHaveLength(40);
  rerender(createElement(ProjectTaskRows, { ...props, tasks: [...tasks] }));
  expect(screen.getAllByTestId("row")).toHaveLength(40);
  rerender(
    createElement(ProjectTaskRows, {
      ...props,
      tasks: tasks.map((t, i) => (i === 0 ? { ...t, updatedAt: 100 } : t)),
    }),
  );
  expect(screen.getAllByTestId("row")[0]?.textContent).toContain("item-0");
  fireEvent.click(screen.getByText("taskList.showMore"));
  expect(screen.getAllByTestId("row")).toHaveLength(43);
});

it("aggregates unread including pinned members but never archived or another Host", () => {
  const tree = { projects: [project], tasks: [task("pin", { pinned: true, unreadAt: 5 })] };
  expect(projectHasUnread(tree, project)).toBe(true);
  expect(
    projectHasUnread(
      {
        ...tree,
        tasks: [
          task("archived", { archived: true, unreadAt: 5 }),
          task("remote", { hostId: "remote:server:s", unreadAt: 5 }),
        ],
      },
      project,
    ),
  ).toBe(false);
});

it("shows the unread dot after the collapsed project name and does not navigate on expand", () => {
  const onCreate = vi.fn();
  const onExpandedChange = vi.fn();
  const props = {
    project,
    expanded: false,
    hasUnread: true,
    onExpandedChange,
    tasks: [],
    onCreate,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh,
  };
  const { rerender } = render(
    createElement(TooltipProvider, {}, createElement(ProjectNode, props)),
  );
  expect(screen.getByTestId("virtual-project-unread").previousElementSibling?.textContent).toBe(
    "Project",
  );
  fireEvent.click(screen.getByTestId("virtual-project-toggle"));
  expect(onExpandedChange).toHaveBeenCalledWith(true);
  expect(onCreate).not.toHaveBeenCalled();
  rerender(
    createElement(TooltipProvider, {}, createElement(ProjectNode, { ...props, expanded: true })),
  );
  expect(screen.queryByTestId("virtual-project-unread")).toBeNull();
});

it("keeps five-row pagination and renders pinned tasks with title/all/less", () => {
  const tasks = Array.from({ length: 23 }, (_, i) => task(`item-${i}`));
  const { rerender } = render(
    createElement(ProjectTaskRows, { tasks, onSelect: vi.fn(), refresh }),
  );
  expect(screen.getAllByTestId("row")).toHaveLength(5);
  fireEvent.click(screen.getByText("taskList.showMore"));
  expect(screen.getAllByTestId("row")).toHaveLength(10);
  rerender(createElement(ProjectTaskRows, { tasks: [...tasks], onSelect: vi.fn(), refresh }));
  expect(screen.getAllByTestId("row")).toHaveLength(10);
  cleanup();
  render(
    createElement(ProjectTaskRows, {
      tasks: tasks.map((t) => ({ ...t, pinned: true })),
      kind: "pinned",
      onSelect: vi.fn(),
      refresh,
    }),
  );
  expect(screen.getByText("taskList.pinnedSection")).toBeDefined();
  expect(screen.getAllByTestId("row")).toHaveLength(20);
  fireEvent.click(screen.getByText("taskList.showMore"));
  expect(screen.getAllByTestId("row")).toHaveLength(23);
  fireEvent.click(screen.getByText("taskList.showLess"));
  expect(screen.getAllByTestId("row")).toHaveLength(20);
});

it("scopes selection and mobile marker, omits task file shortcuts, and closes only an archived task", async () => {
  const onOpenFileTree = vi.fn();
  const presentation = {
    activeWorkspaceKey: "/two",
    mobileActiveTaskKey: "/one:one",
    sortBy: "updated" as const,
    onOpenFileTree,
  };
  render(
    createElement(
      ProjectTaskListContext.Provider,
      { value: presentation },
      createElement(ProjectTaskRows, {
        tasks: [task("one", { updatedAt: 2 }), task("two")],
        onSelect: vi.fn(),
        refresh,
      }),
    ),
  );
  expect(screen.getAllByTestId("row").map((row) => row.dataset.active)).toEqual(["false", "true"]);
  expect(mocks.rowProps.find((row) => row.task.taskId === "one")?.isMobileActive).toBe(true);
  expect(screen.queryByText("Files")).toBeNull();
  expect(onOpenFileTree).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getAllByText("Archive")[1]!);
  });
  expect(mocks.removeTaskState).toHaveBeenCalledWith("/two", "two", undefined);
});

it("SBV02/04: migrates the legacy group view, preserves collapse and persists the new choice", () => {
  localStorage.setItem(
    "zcode-sidebar-task-preferences",
    JSON.stringify({ sortBy: "created", organizeBy: "grouped" }),
  );
  localStorage.setItem("zcode-workspace-expansion", JSON.stringify({ "/one": false }));
  localStorage.setItem(
    "zcode-project-sidebar-preferences",
    JSON.stringify({ sort: "updated", view: "invalid" }),
  );
  const { result, unmount } = renderHook(() => useProjectSidebarPreferences([], false));
  expect(result.current.view).toBe("grouped");
  expect(result.current.isExpanded(project)).toBe(false);
  act(() => {
    result.current.setExpanded(project, true);
    result.current.setView("timeline");
  });
  unmount();
  const restored = renderHook(() => useProjectSidebarPreferences([], false)).result;
  expect(restored.current.isExpanded(project)).toBe(true);
  expect(restored.current.view).toBe("timeline");
  expect(restored.current.isExpanded({ ...project, hostId: "remote:server:s" })).toBe(true);
});

it("SBV02: unavailable browser persistence still permits view switching", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  try {
    const { result } = renderHook(() => useProjectSidebarPreferences([], false));
    act(() => result.current.setView("timeline"));
    expect(result.current.view).toBe("timeline");
  } finally {
    vi.restoreAllMocks();
  }
});

it("keeps the active task and reports an archive failure", async () => {
  mocks.mutateTask.mockRejectedValueOnce(new Error("offline"));
  render(createElement(ProjectTaskRows, { tasks: [task("one")], onSelect: vi.fn(), refresh }));
  await act(async () => {
    fireEvent.click(screen.getByText("Archive"));
  });
  expect(mocks.removeTaskState).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("taskList.archiveFailed");
});

it("shows empty project rows but keeps an empty pinned section absent", () => {
  const { rerender } = render(
    createElement(ProjectTaskRows, { tasks: [], onSelect: vi.fn(), refresh }),
  );
  expect(screen.getByText("taskList.noTasks")).toBeDefined();
  rerender(
    createElement(ProjectTaskRows, { tasks: [], kind: "pinned", onSelect: vi.fn(), refresh }),
  );
  expect(screen.queryByText("taskList.noTasks")).toBeNull();
  expect(screen.queryByText("taskList.pinnedSection")).toBeNull();
});

it("同步同一控制端的跨窗口排序，同时保留当前窗口未加载的离线入口", () => {
  const remote = { ...project, id: "remote", hostId: "remote:server:a" };
  const { result } = renderHook(() => useProjectSidebarPreferences([project, remote], false));
  const order = [
    JSON.stringify([remote.hostId, remote.id]),
    JSON.stringify([project.hostId, project.id]),
  ];
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "zcode-project-sidebar-preferences",
        newValue: JSON.stringify({ order, view: "projects", expanded: {} }),
      }),
    ),
  );
  expect(result.current.sort([project, remote]).map((p) => p.id)).toEqual(["remote", "p"]);
});
