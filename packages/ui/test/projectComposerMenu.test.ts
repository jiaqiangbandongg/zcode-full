// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectAvailability,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { projectKey } from "@/project-sidebar/view.js";
import { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { clearV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";

const fixture = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  readTree: vi.fn(),
  addEntry: vi.fn(),
  refresh: vi.fn(),
  projects: [] as VirtualProject[],
  availability: new Map<string, ProjectAvailability>(),
  projectId: null as string | null,
  deviceNames: new Map<string, string>(),
  hosts: [] as import("@/project-sidebar/contract.js").RemoteProjectHost[],
  error: null as string | null,
  activeTaskId: null as string | null,
  draftFocusVersion: 0,
  taskGroupId: undefined as string | undefined,
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => null,
  useProjectDirectory: () => ({
    ...fixture,
    tree: { projects: fixture.projects },
    directory: { hosts: fixture.hosts },
    loading: false,
    service: { readDirectory: fixture.readDirectory, readTree: fixture.readTree },
    remoteService: {
      readDirectory: async () => ({ hosts: fixture.hosts }),
      addEntry: fixture.addEntry,
    },
    refresh: fixture.refresh,
  }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => {
  const getWorkspaceState = () => ({
    draftProjectId: fixture.projectId,
    draftTaskGroupId: fixture.taskGroupId,
    activeTaskId: fixture.activeTaskId,
    draftFocusVersion: fixture.draftFocusVersion,
  });
  const getState = () => ({
    getWorkspaceState,
    workspaces: {
      "/same": getWorkspaceState(),
      "remote:server:host:/same": getWorkspaceState(),
    },
  });
  return {
    useZCodeSessionStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(getState()),
      { getState },
    ),
  };
});
vi.mock("@/project-sidebar/ProjectCreation.js", () => ({
  ProjectCreation: ({ defaultDeviceId, onClose }: { defaultDeviceId: string; onClose(): void }) =>
    createElement(
      "div",
      {},
      createElement("input", {
        "aria-label": "project.create",
        value: defaultDeviceId,
        readOnly: true,
      }),
      createElement("button", { onClick: onClose }, "Cancel creation"),
    ),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: import("react").ReactNode }) => children,
}));
vi.mock("@/project-sidebar/ProjectEditor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/project-sidebar/ProjectEditor.js")>();
  return {
    ProjectEditor: (props: import("react").ComponentProps<typeof actual.ProjectEditor>) => {
      const { project, onClose, onSaved } = props;
      // 快捷编辑的替身不能截断远程零匹配时使用的真实创建表单。
      if (!project) return createElement(actual.ProjectEditor, props);
      return createElement(
        "div",
        {},
        createElement("input", {
          "aria-label": "Editing project",
          value: `${project.hostId}/${project.id}`,
          readOnly: true,
        }),
        createElement("button", { onClick: onClose }, "Cancel edit"),
        createElement(
          "button",
          {
            onClick: () => {
              void onSaved(project);
              onClose();
            },
          },
          "Save edit",
        ),
      );
    },
  };
});
// 远程身份详情的连接区读取设备管理服务，覆盖见 remoteIdentityHoverCard.test.ts。
vi.mock("@/project-sidebar/RemoteConnectionProgressSection.js", () => ({
  RemoteConnectionProgressSection: () => null,
}));
vi.mock("@/hooks/useRemoteConnectionEntryVisibility.js", () => ({
  useRemoteConnectionEntryVisibility: () => true,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const key of [
    "hasPointerCapture",
    "releasePointerCapture",
    "setPointerCapture",
    "scrollIntoView",
    "scrollTo",
  ])
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, value: () => false });
});
afterEach(cleanup);
const project = (id: string, hostId = "local"): VirtualProject => ({
  id,
  hostId,
  name: `Project ${id}`,
  roots: [{ rootPath: "/same", position: 0, isPrimary: true }],
  nameOverridden: true,
  pinned: false,
  deleted: false,
  position: Number(id) || 0,
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  clearV4ComposerDraft("/same", undefined, V4_DRAFT_SCOPE_ROOT);
  fixture.refresh.mockClear();
  fixture.deviceNames = new Map();
  fixture.hosts = [];
  fixture.projects = Array.from({ length: 7 }, (_, i) => project(String(i)));
  fixture.availability = new Map();
  fixture.projectId = "1";
  fixture.error = null;
  fixture.activeTaskId = null;
  fixture.draftFocusVersion = 0;
  fixture.taskGroupId = undefined;
});
const props = () => ({
  workspacePath: "/same",
  onCreateTask: vi.fn<ProjectSidebarProps["onCreateTask"]>(),
  onSelectConversationWorkspace: vi.fn(),
  onOpenRemoteWorkspace: vi.fn<NonNullable<ProjectSidebarProps["onOpenRemoteWorkspace"]>>(),
});
const open = () =>
  fireEvent.pointerDown(screen.getByTestId("composer-workspace-trigger"), {
    button: 0,
    ctrlKey: false,
  });
const entries = () =>
  screen.getAllByRole("menuitemcheckbox").filter((e) => e.hasAttribute("data-project-id"));

describe("输入框的虚拟项目目录", () => {
  it("TD07 无文字草稿切项目时沿用内存分组，不依赖持久草稿", () => {
    fixture.taskGroupId = "group-a";
    const p = props();
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(entries().find((entry) => entry.getAttribute("data-project-id") === "0")!);
    expect(p.onCreateTask).toHaveBeenCalledWith({ projectId: "0", taskGroupId: "group-a" });
  });
  it("快捷编辑使用选中身份且保存/取消不导航", () => {
    const p = {
      ...props(),
      showEditProject: true,
    };
    render(createElement(ProjectComposerMenu, p));
    const edit = screen.getByRole("button", { name: "project.edit" });
    fireEvent.click(edit);
    expect(screen.getByLabelText("Editing project").getAttribute("value")).toBe("local/1");
    fireEvent.click(screen.getByText("Cancel edit"));
    expect(fixture.refresh).not.toHaveBeenCalled();
    fireEvent.click(edit);
    fireEvent.click(screen.getByText("Save edit"));
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Editing project")).toBeNull();
    expect(p.onCreateTask).not.toHaveBeenCalled();
    expect(p.onSelectConversationWorkspace).not.toHaveBeenCalled();
  });
  it("同 ID 的远端项目编辑保持 Host 身份", () => {
    fixture.projects.push(project("1", "remote:server:host"));
    fixture.availability.set(projectKey(project("1", "remote:server:host")), {
      online: true,
      entryId: "remote-entry",
    });
    render(
      createElement(ProjectComposerMenu, {
        ...props(),
        showEditProject: true,
        workspaceIdentity: "remote:server:host:/same",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "project.edit" }));
    expect(screen.getByLabelText("Editing project").getAttribute("value")).toBe(
      "remote:server:host/1",
    );
  });
  it.each(["not-enabled", "no-project", "deleted", "offline", "legacy"])(
    "不可编辑时不显示快捷入口：%s",
    (kind) => {
      if (kind === "no-project") fixture.projectId = null;
      if (kind === "deleted") fixture.projects = [];
      if (kind === "offline")
        fixture.availability.set(projectKey(fixture.projects[1]!), { online: false });
      if (kind === "legacy") fixture.projects[1]!.legacySingleRoot = true;
      render(
        createElement(ProjectComposerMenu, { ...props(), showEditProject: kind !== "not-enabled" }),
      );
      expect(screen.queryByRole("button", { name: "project.edit" })).toBeNull();
    },
  );
  it.each(["project", "task", "draft"])("%s 身份切换使旧编辑器失效，切回也不复活", (kind) => {
    const p = { ...props(), showEditProject: true };
    const view = render(createElement(ProjectComposerMenu, p));
    fireEvent.click(screen.getByRole("button", { name: "project.edit" }));
    if (kind === "project") fixture.projectId = "2";
    if (kind === "task") fixture.activeTaskId = "another-task";
    if (kind === "draft") fixture.draftFocusVersion = 1;
    view.rerender(createElement(ProjectComposerMenu, p));
    expect(screen.queryByLabelText("Editing project")).toBeNull();
    fixture.projectId = "1";
    fixture.activeTaskId = null;
    fixture.draftFocusVersion = 0;
    fixture.taskGroupId = undefined;
    view.rerender(createElement(ProjectComposerMenu, p));
    expect(screen.queryByLabelText("Editing project")).toBeNull();
  });
  it("创建项目复用表单，关闭菜单且不切换聊天，取消后可以重开", () => {
    const p = props();
    render(createElement(ProjectComposerMenu, p));
    open();
    expect(screen.queryByText("workspace.openFolder")).toBeNull();
    fireEvent.click(screen.getByText("project.create"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByLabelText("project.create").getAttribute("value")).toBe("local");
    expect(p.onCreateTask).not.toHaveBeenCalled();
    expect(p.onSelectConversationWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel creation"));
    expect(screen.queryByLabelText("project.create")).toBeNull();
    open();
    fireEvent.click(screen.getByText("project.create"));
    expect(screen.getByLabelText("project.create")).toBeTruthy();
  });
  it.each([null, "task"])("创建项目默认设备与侧栏一致，activeTaskId=%s", (activeTaskId) => {
    fixture.activeTaskId = activeTaskId;
    render(
      createElement(ProjectComposerMenu, {
        ...props(),
        workspaceIdentity: "remote:server:host:/same",
      }),
    );
    open();
    fireEvent.click(screen.getByText("project.create"));
    expect(screen.getByLabelText("project.create").getAttribute("value")).toBe(
      activeTaskId ? "remote:server:host" : "local",
    );
  });
  it("当前项目与候选按 roots 数量显示文件夹，目录更新不保留旧图标", () => {
    fixture.projects[0]!.roots = [];
    fixture.projects[1]!.roots.push({ rootPath: "/extra", position: 1, isPrimary: false });
    const p = props();
    const view = render(createElement(ProjectComposerMenu, p));
    const trigger = screen.getByTestId("composer-workspace-trigger");
    expect(trigger.querySelector(".lucide-folders")).not.toBeNull();
    open();
    expect(entries()[1]!.querySelector(".lucide-folders")).not.toBeNull();
    expect(entries()[0]!.querySelector(".lucide-folder")).not.toBeNull();
    expect(entries()[2]!.querySelector(".lucide-folder")).not.toBeNull();
    fixture.projects = fixture.projects.map((project) => ({
      ...project,
      roots: project.roots.slice(0, 1),
    }));
    view.rerender(createElement(ProjectComposerMenu, p));
    expect(trigger.querySelector(".lucide-folder")).not.toBeNull();
    expect(entries()[1]!.querySelector(".lucide-folder")).not.toBeNull();
  });
  it("完整显示未打开项目，按名称和任意 root 搜索，选择传项目身份", () => {
    const p = props();
    fixture.projects[6]!.roots.push({
      rootPath: "/additional/search-me",
      position: 1,
      isPrimary: false,
    });
    render(createElement(ProjectComposerMenu, p));
    open();
    expect(entries().map((e) => e.textContent)).toEqual(fixture.projects.map((p) => p.name));
    fireEvent.change(screen.getByPlaceholderText("chat.empty.workspaceSearchPlaceholder"), {
      target: { value: "search-me" },
    });
    expect(entries().map((e) => e.textContent)).toEqual(["Project 6"]);
    fireEvent.click(entries()[0]!);
    expect(p.onCreateTask).toHaveBeenCalledWith({ projectId: "6" });
  });
  it("同目录两个项目只选中草稿归属，自定义名字用于 chip", () => {
    render(createElement(ProjectComposerMenu, props()));
    expect(screen.getByTestId("composer-workspace-trigger").textContent).toContain("Project 1");
    open();
    expect(
      entries()
        .filter((e) => e.getAttribute("aria-checked") === "true")
        .map((e) => e.dataset.projectId),
    ).toEqual(["1"]);
  });
  it("同 ID 不同 Host 独立，离线项保留且禁止选择，零 root 可选择", () => {
    const remote = project("1", "remote:server:host");
    remote.name = "Remote";
    fixture.projects.push(remote);
    fixture.projects[0]!.roots = [];
    fixture.availability.set(projectKey(remote), { online: false, entryId: "offline" });
    const p = props();
    render(
      createElement(ProjectComposerMenu, { ...p, workspaceIdentity: "remote:server:host:/same" }),
    );
    expect(screen.getByTestId("composer-workspace-trigger").textContent).toContain("Remote");
    expect(
      screen.getByTestId("composer-workspace-trigger").querySelector(".lucide-cloud"),
    ).not.toBeNull();
    open();
    const entry = entries().find((e) => e.dataset.projectHost === remote.hostId)!;
    expect(entry.querySelector(".lucide-cloud")).not.toBeNull();
    expect(entry.getAttribute("aria-checked")).toBe("true");
    expect(entry.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(entry);
    expect(p.onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(entries()[0]!);
    expect(p.onCreateTask).toHaveBeenCalledWith({ projectId: "0" });
  });
  it("手机选择在线远端项目保留 Host 身份，复用上层草稿命令", () => {
    const remote = project("remote-project", "remote:server:host");
    fixture.projects = [remote];
    fixture.availability.set(projectKey(remote), { online: true, entryId: "online" });
    const p = props();
    render(createElement(ProjectComposerMenu, { ...p, compactForRemoteControl: true }));
    open();
    fireEvent.click(entries()[0]!);
    expect(p.onCreateTask).toHaveBeenCalledWith({ projectId: remote.id, hostId: remote.hostId });
  });
  it("手机禁用新设备入口时仍能创建项目，不在项目中工作仍可用", () => {
    render(
      createElement(ProjectComposerMenu, {
        ...props(),
        allowRemoteWorkspace: false,
        compactForRemoteControl: true,
      }),
    );
    open();
    expect(screen.queryByText("chat.empty.newRemoteConnection")).toBeNull();
    expect(screen.queryByText("workspace.openFolder")).toBeNull();
    expect(screen.getByText("project.create")).toBeTruthy();
    expect(screen.getByText("chat.empty.workOutsideProject")).toBeTruthy();
  });
  it("目录更新立即更新候选，未归类不按目录猜选中", () => {
    fixture.projectId = null;
    const p = props();
    const view = render(createElement(ProjectComposerMenu, p));
    expect(screen.queryByTestId("composer-project-detach")).toBeNull();
    open();
    expect(entries().every((e) => e.getAttribute("aria-checked") === "false")).toBe(true);
    fixture.projects = [{ ...fixture.projects[2]!, name: "Renamed" }, fixture.projects[0]!];
    view.rerender(createElement(ProjectComposerMenu, p));
    expect(entries().map((e) => e.textContent)).toEqual(["Renamed", "Project 0"]);
  });
  it("保留原 footer，远程菜单由 Root 打开并关闭当前菜单", () => {
    const p = props();
    render(createElement(ProjectComposerMenu, p));
    open();
    expect(screen.getByText("project.create")).toBeTruthy();
    expect(screen.getByText("chat.empty.workOutsideProject")).toBeTruthy();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    expect(p.onOpenRemoteWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("后台只解除原草稿提交限制，显式继续仍须选目录且失效通知不锁新草稿", async () => {
    const p = props();
    const pending = vi.fn();
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    const view = render(
      createElement(
        ComposerSubmissionPendingContext.Provider,
        { value: pending },
        createElement(ProjectComposerMenu, p),
      ),
    );
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const target = p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!;
    expect(pending).toHaveBeenLastCalledWith(true);
    act(() => target.onVisibilityChange?.(false));
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("chat-remote-folder")).toBeNull();
    await act(async () => target.finish({ kind: "connected", sourceServerId: "actual-source" }));
    expect(await screen.findByTestId("chat-remote-folder")).toBeTruthy();
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(p.onCreateTask).not.toHaveBeenCalled();
    fixture.draftFocusVersion++;
    view.rerender(
      createElement(
        ComposerSubmissionPendingContext.Provider,
        { value: pending },
        createElement(ProjectComposerMenu, p),
      ),
    );
    expect(pending).toHaveBeenLastCalledWith(false);
    act(() => target.onVisibilityChange?.(true));
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("chat-remote-folder")).toBeNull();
  });
  it.each(["removed", "replaced", "draft-changed"])(
    "后台继续先复验原成员，迟到结果不能授权导航：%s",
    async (change) => {
      const p = props();
      const host = {
        id: "remote:server:actual-source",
        membershipId: "original",
        kind: "server" as const,
        target: { kind: "server" as const, url: "https://remote.example.com" },
        position: 0,
      };
      fixture.hosts = [host];
      render(createElement(ProjectComposerMenu, p));
      open();
      fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
      const target = p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!;
      if (change === "removed") fixture.hosts = [];
      if (change === "replaced") fixture.hosts = [{ ...host, membershipId: "replacement" }];
      const validation = target.canFinish?.({ kind: "connected", sourceServerId: "actual-source" });
      if (change === "draft-changed") fixture.draftFocusVersion++;
      expect(await validation).toBe(false);
      expect(screen.queryByTestId("chat-remote-folder")).toBeNull();
      expect(p.onCreateTask).not.toHaveBeenCalled();
    },
  );
  it("后台继续通过校验后仍携带原成员资格，挂载间隙移除不能重新登记", async () => {
    const p = props();
    const remote = project("existing", "remote:server:actual-source");
    fixture.hosts = [
      {
        id: remote.hostId,
        membershipId: "original",
        kind: "server",
        target: { kind: "server", url: "https://remote.example.com" },
        position: 0,
      },
    ];
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    fixture.readTree.mockResolvedValue({ projects: [remote], tasks: [] });
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const target = p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!;
    expect(await target.canFinish?.({ kind: "connected", sourceServerId: "actual-source" })).toBe(
      true,
    );
    fixture.hosts = [];
    await act(async () => target.finish({ kind: "connected", sourceServerId: "actual-source" }));
    await waitFor(() =>
      expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    expect((await screen.findByRole("alert")).textContent).toContain("project.hostRemoved");
    expect(p.onCreateTask).not.toHaveBeenCalled();
  });
  it("连接成功必选目录，确认唯一项目后才进入原项目的新草稿", async () => {
    const p = props();
    const remote = project("existing", "remote:server:actual-source");
    fixture.hosts = [
      {
        id: remote.hostId,
        membershipId: "membership",
        kind: "server",
        target: { kind: "server", url: "https://remote.example.com" },
        position: 0,
      },
    ];
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    fixture.readTree.mockResolvedValue({ projects: [remote], tasks: [] });
    fixture.addEntry.mockResolvedValue({});
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const preference = p.onOpenRemoteWorkspace.mock.calls[0]![0]!;
    await act(async () => {
      preference.returnTarget!.finish({ kind: "connected", sourceServerId: "actual-source" });
    });
    expect(await screen.findByTestId("chat-remote-folder")).toBeTruthy();
    expect(screen.queryByTestId("composer-create-project-on-device")).toBeNull();
    expect(screen.queryByLabelText("project.create")).toBeNull();
    expect(p.onCreateTask).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    await waitFor(() =>
      expect(p.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: remote.id, hostId: remote.hostId }),
      ),
    );
    expect(fixture.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMembershipId: "membership",
        project: expect.objectContaining({ projectId: remote.id }),
      }),
    );
  });
  it.each([null, "existing-task"])(
    "远程目录交付只继承当前草稿的分组，activeTaskId=%s",
    async (activeTaskId) => {
      fixture.activeTaskId = activeTaskId;
      // 空白新建的分组只在内存；远程目录确认也必须使用同一 owner。
      fixture.taskGroupId = "chosen-group";
      const p = props();
      const remote = project("existing", "remote:server:actual-source");
      fixture.hosts = [
        {
          id: remote.hostId,
          membershipId: "membership",
          kind: "server",
          target: { kind: "server", url: "https://remote.example.com" },
          position: 0,
        },
      ];
      fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
      fixture.readTree.mockResolvedValue({ projects: [remote], tasks: [] });
      render(createElement(ProjectComposerMenu, p));
      open();
      fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
      await act(async () => {
        p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!.finish({
          kind: "connected",
          sourceServerId: "actual-source",
        });
      });
      await waitFor(() =>
        expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(
          false,
        ),
      );
      fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
      await waitFor(() =>
        expect(p.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: remote.id,
            hostId: remote.hostId,
            taskGroupId: activeTaskId ? null : "chosen-group",
          }),
        ),
      );
    },
  );
  it("按 Host 和精确单目录匹配，不自动选择其他设备、父目录或软删项目", async () => {
    const p = props();
    const hostId = "remote:server:actual-source";
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    fixture.readTree.mockResolvedValue({
      projects: [
        project("other-device", "remote:server:other"),
        { ...project("parent", hostId), roots: [{ rootPath: "/", position: 0, isPrimary: true }] },
        {
          ...project("prefix", hostId),
          roots: [{ rootPath: "/same-other", position: 0, isPrimary: true }],
        },
        { ...project("deleted", hostId), deleted: true },
      ],
      tasks: [],
    });
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    await act(async () => {
      p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!.finish({
        kind: "connected",
        sourceServerId: "actual-source",
      });
    });
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    expect(await screen.findByTestId("virtual-project-name")).toBeTruthy();
    expect(p.onCreateTask).not.toHaveBeenCalled();
  });
  it("项目列表读取失败不能当零项，重试后仍使用原项目身份；准备失败保持可取消", async () => {
    const p = props();
    const remote = project("existing", "remote:server:actual-source");
    fixture.hosts = [
      {
        id: remote.hostId,
        membershipId: "membership",
        kind: "server",
        target: { kind: "server", url: "https://remote.example.com" },
        position: 0,
      },
    ];
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    fixture.readTree.mockRejectedValueOnce(new Error("project list unavailable"));
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    await act(async () => {
      p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!.finish({
        kind: "connected",
        sourceServerId: "actual-source",
      });
    });
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    expect((await screen.findByRole("alert")).textContent).toContain("project list unavailable");
    expect(p.onCreateTask).not.toHaveBeenCalled();
    fixture.readTree.mockResolvedValue({ projects: [remote], tasks: [] });
    p.onCreateTask.mockImplementation((request) => {
      if (typeof request === "object") request.onError?.(new Error("attachment unavailable"));
    });
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("attachment unavailable"),
    );
    expect(screen.getByTestId("chat-remote-folder")).toBeTruthy();
    fireEvent.click(screen.getByText("common.cancel"));
    expect(screen.queryByTestId("chat-remote-folder")).toBeNull();
    expect(screen.getByTestId("composer-workspace-trigger").textContent).toContain("Project 1");
    expect(screen.getByRole("status").textContent).toContain("chat.remoteFolder.restored");
  });
  it("取消后迟到的项目列表不登记或切换聊天", async () => {
    const p = props();
    let finish!: (value: { projects: VirtualProject[]; tasks: [] }) => void;
    fixture.readDirectory.mockResolvedValue({ path: "/same", entries: [] });
    fixture.readTree.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    await act(async () => {
      p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!.finish({
        kind: "connected",
        sourceServerId: "actual-source",
      });
    });
    fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.keyDown(screen.getByTestId("chat-remote-folder"), { key: "Escape" });
    await act(async () => {
      finish({ projects: [project("late", "remote:server:actual-source")], tasks: [] });
    });
    expect(screen.queryByTestId("chat-remote-folder")).toBeNull();
    expect(p.onCreateTask).not.toHaveBeenCalled();
    open();
    fireEvent.click(screen.getByText("project.create"));
    expect(screen.getByLabelText("project.create").getAttribute("value")).toBe("local");
  });
  it("未返回实际设备身份时不提供猜测设备的继续操作", () => {
    const p = props();
    render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    act(() =>
      p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!.finish({
        kind: "connected",
        sourceServerId: undefined,
      }),
    );
    expect(screen.queryByText("chat.empty.createProjectOnDevice")).toBeNull();
  });
  it("聊天身份已更换时拒绝迟到连接结果", () => {
    const p = props();
    const view = render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const target = p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!;
    fixture.activeTaskId = "another-task";
    expect(target.isCurrent()).toBe(false);
    view.rerender(createElement(ProjectComposerMenu, p));
    expect(target.isCurrent()).toBe(false);
    target.finish({ kind: "connected", sourceServerId: "stale-source" });
    expect(screen.queryByText("chat.empty.createProjectOnDevice")).toBeNull();
    expect(p.onCreateTask).not.toHaveBeenCalled();
  });
  it("取消不提供继续操作，失效的旧继续操作也不能打开项目表单", () => {
    const p = props();
    const view = render(createElement(ProjectComposerMenu, p));
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const target = p.onOpenRemoteWorkspace.mock.calls[0]![0]!.returnTarget!;
    act(() => target.finish({ kind: "cancelled" }));
    expect(screen.queryByText("chat.empty.createProjectOnDevice")).toBeNull();
    open();
    fireEvent.click(screen.getByText("chat.empty.newRemoteConnection"));
    const nextTarget = p.onOpenRemoteWorkspace.mock.calls[1]![0]!.returnTarget!;
    act(() => nextTarget.finish({ kind: "connected", sourceServerId: "actual-source" }));
    const oldContinue = screen.queryByText("chat.remoteFolder.confirm");
    fixture.draftFocusVersion += 1;
    view.rerender(createElement(ProjectComposerMenu, p));
    if (oldContinue) fireEvent.click(oldContinue);
    expect(nextTarget.isCurrent()).toBe(false);
    expect(screen.queryByLabelText("project.create")).toBeNull();
  });
  it("读取失败显示错误，不使用工作区 tab 兜底", () => {
    fixture.error = "project.read-failed";
    render(createElement(ProjectComposerMenu, props()));
    open();
    expect(within(screen.getByRole("menu")).getByText("project.read-failed")).toBeTruthy();
  });
});

it("同名远程项目的在线/离线设备名均可见，按设备名搜索且悬停详情不改变选择", async () => {
  fixture.projects = [
    project("same", "remote:server:alpha"),
    project("same", "remote:server:beta"),
  ];
  fixture.deviceNames = new Map([
    ["alpha", "Alpha"],
    ["beta", "Beta"],
  ]);
  fixture.hosts = ["alpha", "beta"].map((id) => ({
    id: `remote:server:${id}`,
    membershipId: id,
    kind: "server",
    position: 0,
    target: { kind: "server", name: id, url: `https://${id}.example.com` },
    connectionStatus: id === "alpha" ? "online" : "offline",
  }));
  fixture.projects.forEach((p, i) =>
    fixture.availability.set(projectKey(p), { online: i === 0, entryId: p.hostId }),
  );
  const input = props();
  const view = render(createElement(ProjectComposerMenu, input));
  open();
  expect(entries()[0]!.textContent).toContain("Alpha");
  expect(entries()[1]!.textContent).toContain("Beta");
  const offline = entries()[1]!;
  fireEvent.pointerEnter(offline.parentElement!, { pointerType: "mouse" });
  const details = await screen.findByTestId("remote-identity-details");
  expect(details.textContent).toContain("beta.example.com");
  fireEvent.pointerLeave(offline.parentElement!, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
  fireEvent.change(screen.getByPlaceholderText("chat.empty.workspaceSearchPlaceholder"), {
    target: { value: "Beta" },
  });
  expect(entries()).toHaveLength(1);
  expect(entries()[0]!.textContent).toContain("Beta");
  expect(input.onCreateTask).not.toHaveBeenCalled();
  fixture.deviceNames = new Map();
  view.rerender(createElement(ProjectComposerMenu, input));
  expect(entries()).toHaveLength(1);
  expect(entries()[0]!.textContent).toContain("beta");
});
