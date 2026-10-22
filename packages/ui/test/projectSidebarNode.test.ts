// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSidebarNode } from "@/project-sidebar/ProjectSidebarNode.js";

const probes = vi.hoisted(() => ({ node: vi.fn() }));
vi.mock("@/project-sidebar/ProjectNode.js", () => ({
  ProjectNode: (props: { onCreate(): void }) => {
    probes.node(props);
    return createElement("button", { onClick: props.onCreate }, "Create");
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStoreApi: () => ({}) }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixture(): ComponentProps<typeof ProjectSidebarNode> {
  return {
    project: {
      id: "p",
      hostId: "local",
      name: "Project",
      roots: [],
      pinned: false,
      deleted: false,
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      nameOverridden: false,
    },
    tasks: [
      {
        taskId: "s",
        hostId: "local",
        workspacePath: "/example",
        projectId: "p",
        title: "Task",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    expanded: true,
    onExpandedChange: vi.fn(),
    onEdit: vi.fn(),
    onViewFiles: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onCreateTask: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remoteActions: () => [],
  };
}

it("等价任务数组不刷新项目；任务字段、顺序与成员变化仍传入内容层", () => {
  const props = fixture();
  const { rerender } = render(createElement(ProjectSidebarNode, props));
  rerender(createElement(ProjectSidebarNode, { ...props, tasks: [...props.tasks] }));
  expect(probes.node).toHaveBeenCalledTimes(1);
  const changed = { ...props.tasks[0]!, title: "Renamed task" };
  const other = { ...changed, taskId: "other" };
  for (const tasks of [[changed], [changed, other], [other, changed], []]) {
    probes.node.mockClear();
    rerender(createElement(ProjectSidebarNode, { ...props, tasks }));
    expect(probes.node).toHaveBeenCalledOnce();
    expect(probes.node.mock.lastCall![0].tasks).toBe(tasks);
  }
});

it("回调与项目身份变化不能被 memo 忽略，新建始终使用当前目标", () => {
  const props = fixture();
  const { rerender, getByText } = render(createElement(ProjectSidebarNode, props));
  const latestCreate = vi.fn();
  rerender(createElement(ProjectSidebarNode, { ...props, onCreateTask: latestCreate }));
  fireEvent.click(getByText("Create"));
  expect(props.onCreateTask).not.toHaveBeenCalled();
  expect(latestCreate).toHaveBeenLastCalledWith({ projectId: "p", taskGroupId: null });
  const project = { ...props.project, id: "remote-p", hostId: "remote:server:example" };
  rerender(
    createElement(ProjectSidebarNode, {
      ...props,
      project,
      isWebRemoteControl: true,
      onCreateTask: latestCreate,
    }),
  );
  fireEvent.click(getByText("Create"));
  expect(latestCreate).toHaveBeenLastCalledWith({
    projectId: "remote-p",
    hostId: "remote:server:example",
    taskGroupId: null,
  });
});
