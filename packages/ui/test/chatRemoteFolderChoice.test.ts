// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLegacySingleRootProjectService } from "@zcode/services/node";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
  RemoteProjectHost,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { ChatRemoteFolderSelection } from "@/project-sidebar/ChatRemoteFolderSelection.js";
const fixture = vi.hoisted(() => ({ hosts: [] as RemoteProjectHost[], refresh: vi.fn() }));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useProjectDirectory: () => ({ directory: { hosts: fixture.hosts }, refresh: fixture.refresh }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => null,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const hostId = "remote:server:source";
const project = (id: string): VirtualProject => ({
  id,
  hostId,
  name: "Same name",
  roots: [{ rootPath: "/repo", isPrimary: true, position: 0 }],
  nameOverridden: true,
  pinned: false,
  deleted: false,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
  fixture.hosts = [
    {
      id: hostId,
      membershipId: "member",
      kind: "server",
      target: { kind: "server", url: "https://remote.example.com" },
      position: 0,
    },
  ];
});
afterEach(cleanup);
function setup() {
  const projects = [project("first"), project("second")];
  const readTree = vi.fn().mockResolvedValue({ projects, tasks: [] });
  const addEntry = vi.fn().mockResolvedValue({});
  const service = {
    readDirectory: vi.fn().mockResolvedValue({ path: "/repo", entries: [] }),
    readTree,
  } as unknown as IProjectService;
  const remoteService = {
    readDirectory: vi.fn(async () => ({ hosts: fixture.hosts })),
    addEntry,
  } as unknown as IRemoteProjectService;
  const onCreateTask = vi.fn<ProjectSidebarProps["onCreateTask"]>();
  const onClose = vi.fn();
  const request = { sourceServerId: "source", isCurrent: vi.fn(() => true) };
  const view = render(
    createElement(ChatRemoteFolderSelection, {
      request,
      service,
      remoteService,
      onCreateTask,
      onClose,
    }),
  );
  return { projects, readTree, addEntry, onCreateTask, onClose, request, ...view };
}
async function confirm() {
  await waitFor(() =>
    expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
  return screen.findAllByTestId("chat-remote-project-pick");
}
it("目录确认期间只在按钮内显示加载，失败后保留路径并恢复重试", async () => {
  const f = setup();
  let rejectRead!: (error: Error) => void;
  f.readTree.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const button = screen.getByRole("button", { name: "chat.remoteFolder.confirm" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(rejectRead).toBeDefined());
  const status = screen.getByRole("status");
  expect(button.contains(status)).toBe(true);
  expect(status.textContent).toBe("directoryBrowser.opening");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("textbox").getAttribute("value")).toBe("/repo");
  fireEvent.click(button);
  expect(f.readTree).toHaveBeenCalledOnce();
  await act(async () => rejectRead(new Error("Source offline")));
  expect(screen.getByRole("alert").textContent).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "chat.remoteFolder.confirm" })).toBe(button);
  expect(screen.getByRole("textbox").getAttribute("value")).toBe("/repo");
  fireEvent.click(button);
  expect(await screen.findAllByTestId("chat-remote-project-pick")).toHaveLength(2);
});
it("目录对应两个同名项目时保留身份，必须由用户选择后才准备新草稿", async () => {
  const f = setup();
  const candidates = await confirm();
  expect(candidates.map((item) => item.dataset.projectId)).toEqual(["first", "second"]);
  expect(candidates[0]!.textContent).toContain("first");
  expect(candidates[1]!.textContent).toContain("second");
  expect(f.onCreateTask).not.toHaveBeenCalled();
  fireEvent.click(candidates[1]!);
  fireEvent.click(candidates[1]!);
  await waitFor(() => expect(f.onCreateTask).toHaveBeenCalledOnce());
  expect(f.onCreateTask).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "second", hostId }),
  );
  expect(f.addEntry).toHaveBeenCalledOnce();
  expect(f.onClose).not.toHaveBeenCalled();
  await act(async () => {
    const request = f.onCreateTask.mock.calls[0]![0];
    if (typeof request === "object") request.onComplete?.();
  });
  expect(f.onClose).toHaveBeenCalledOnce();
});
it("候选失效后显示错误，重读剩余项目仍须明确选择", async () => {
  const f = setup();
  const candidates = await confirm();
  f.readTree.mockResolvedValue({ projects: [f.projects[0]], tasks: [] });
  fireEvent.click(candidates[1]!);
  expect((await screen.findByRole("alert")).textContent).toContain("project.not-found");
  expect(f.addEntry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("common.retry"));
  await waitFor(() => expect(screen.getAllByTestId("chat-remote-project-pick")).toHaveLength(1));
  expect(f.onCreateTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("chat-remote-project-pick"));
  await waitFor(() =>
    expect(f.onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: "first" })),
  );
});
it.each(["cancel", "stale", "membership"])(
  "选择复验期间 %s 使旧响应失效，不导航或登记",
  async (change) => {
    const f = setup();
    const candidates = await confirm();
    let resolve!: (value: unknown) => void;
    f.readTree.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(candidates[0]!);
    await waitFor(() => expect(resolve).toBeDefined());
    if (change === "cancel") fireEvent.click(screen.getByText("common.cancel"));
    else if (change === "stale") f.request.isCurrent.mockReturnValue(false);
    else fixture.hosts = [{ ...fixture.hosts[0]!, membershipId: "replacement" }];
    await act(async () => resolve({ projects: f.projects, tasks: [] }));
    expect(f.addEntry).not.toHaveBeenCalled();
    expect(f.onCreateTask).not.toHaveBeenCalled();
    if (change === "membership")
      expect(screen.getByRole("alert").textContent).toContain("project.hostRemoved");
  },
);
it("精确 Host 与单目录过滤仍适用于只读旧远端，同路径名称不决定身份", async () => {
  const f = setup();
  f.readTree.mockResolvedValue({
    legacySingleRoot: true,
    projects: [
      ...f.projects,
      { ...project("other"), hostId: "remote:server:other" },
      { ...project("parent"), roots: [{ rootPath: "/", position: 0, isPrimary: true }] },
      { ...project("child"), roots: [{ rootPath: "/repo/sub", position: 0, isPrimary: true }] },
      { ...project("deleted"), deleted: true },
    ],
    tasks: [],
  });
  const candidates = await confirm();
  expect(candidates.map((row) => row.dataset.projectId)).toEqual(["first", "second"]);
  expect(screen.queryByTestId("virtual-project-save")).toBeNull();
  expect(document.activeElement).toBe(candidates[0]);
  fireEvent.click(candidates[0]!);
  await waitFor(() =>
    expect(f.onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "first", hostId }),
    ),
  );
});
it.each(["deleted", "moved", "offline"])(
  "候选 %s 时显示实际错误且不登记替代项目",
  async (failure) => {
    const f = setup();
    const candidates = await confirm();
    if (failure === "offline") f.readTree.mockRejectedValue(new Error("Source offline"));
    else
      f.readTree.mockResolvedValue({
        projects: [
          f.projects[0],
          {
            ...f.projects[1],
            ...(failure === "deleted"
              ? { deleted: true }
              : { roots: [{ rootPath: "/other", position: 0, isPrimary: true }] }),
          },
        ],
        tasks: [],
      });
    fireEvent.click(candidates[1]!);
    expect((await screen.findByRole("alert")).textContent).toContain(
      failure === "offline" ? "Source offline" : "project.not-found",
    );
    expect(f.addEntry).not.toHaveBeenCalled();
    expect(f.onCreateTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-remote-folder")).toBeTruthy();
    fireEvent.click(screen.getByText("common.cancel"));
    expect(f.onClose).toHaveBeenCalledOnce();
  },
);

it.each([false, true])("旧端等价路径复用原项目身份，多匹配=%s", async (multiple) => {
  const f = setup();
  const raw = "/repo/child/..";
  const legacy = createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: async () => ({ platform: "linux", homedir: "/repo" }),
      read: async () => [],
    },
    readSettings: async () => ({ recentProjects: multiple ? [raw, "/repo"] : [raw] }),
    readTasks: async () => [],
    ensureConversation: async () => "/unused",
  });
  f.readTree.mockImplementation(legacy.readTree);
  const original = (await legacy.readProjects())[0]!;
  await waitFor(() =>
    expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
  if (multiple) {
    const choices = await screen.findAllByTestId("chat-remote-project-pick");
    expect(choices).toHaveLength(2);
    expect(f.onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(choices[0]!);
  }
  await waitFor(() =>
    expect(f.onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: original.id, hostId }),
    ),
  );
  expect(f.addEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      project: expect.objectContaining({ projectId: original.id, roots: original.roots }),
    }),
  );
  expect(screen.queryByTestId("virtual-project-save")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
