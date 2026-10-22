// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
const service = vi.hoisted(() => ({ mutateTask: vi.fn(async () => null), renameTask: vi.fn() }));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => ({
    directory: {
      hosts: [{ id: "remote:server:source", kind: "ssh", connectionStatus: "online", position: 0 }],
    },
    projects: [{ id: "p", hostId: "remote:server:source", name: "Remote project" }],
  }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    windowControllerService: { mutateTask: service.mutateTask },
    zcodeTaskService: { renameTask: service.renameTask },
  }),
}));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => null,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/TaskList.js", () => ({
  TaskList: (props: {
    onRenameTask(id: string, title: string): Promise<unknown>;
    onSetTaskUnread(id: string, unread: boolean): Promise<unknown>;
  }) =>
    createElement(
      "div",
      {},
      createElement("button", { onClick: () => void props.onRenameTask("s", "renamed") }, "Rename"),
      createElement("button", { onClick: () => void props.onSetTaskUnread("s", false) }, "Read"),
    ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const remoteTask = {
  taskId: "s",
  hostId: "remote:server:source",
  workspaceIdentity: "remote:server:source:/repo",
  workspacePath: "/repo",
  projectId: "p",
  pinned: false,
  archived: false,
  title: "old",
  traceId: "s",
  mode: "default",
  createdAt: 1,
  updatedAt: 1,
  unreadAt: 50,
};

it.each(["project", "pinned", "timeline"] as const)(
  "%s remote task rows do not open identity details on hover or focus",
  async (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(
      createElement(ProjectTaskRows, {
        tasks: [remoteTask],
        kind,
        onSelect: vi.fn(),
        refresh: vi.fn(async () => {}),
      }),
    );
    const action = screen.getByText("Rename");
    fireEvent.pointerEnter(action, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByTestId("remote-identity-details")).toBeNull();
    fireEvent.pointerLeave(action, { pointerType: "mouse" });
    fireEvent.focus(action);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByTestId("remote-identity-details")).toBeNull();
  },
);
it("routes an unopened remote task through the Controller and preserves unread CAS", async () => {
  const refresh = vi.fn(async () => {});
  render(
    createElement(ProjectTaskRows, {
      tasks: [remoteTask],
      onSelect: vi.fn(),
      refresh,
    }),
  );
  fireEvent.click(screen.getByText("Rename"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(service.mutateTask).toHaveBeenCalledWith({
    address: {
      taskId: "s",
      workspacePath: "/repo",
      workspaceIdentity: "remote:server:source:/repo",
      sourceServerId: "source",
    },
    mutation: { kind: "rename", title: "renamed" },
  });
  expect(service.renameTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Read"));
  await waitFor(() => expect(service.mutateTask).toHaveBeenCalledTimes(2));
  expect(service.mutateTask.mock.calls[1]).toEqual([
    expect.objectContaining({ mutation: { kind: "mark-read", expectedUnreadAt: 50 } }),
  ]);
});
