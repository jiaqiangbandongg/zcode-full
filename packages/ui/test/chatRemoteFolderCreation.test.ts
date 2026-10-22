// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { ChatRemoteFolderSelection } from "@/project-sidebar/ChatRemoteFolderSelection.js";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
const fixture = vi.hoisted(() => ({ hosts: [] as unknown[] }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useProjectDirectory: () => ({
    directory: { hosts: fixture.hosts },
    deviceNames: new Map([["source", "Device"]]),
    refresh: async () => {},
  }),
  useOptionalProjectDirectory: () => null,
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const name of ["scrollIntoView", "scrollTo"])
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: () => {} });
});
afterEach(cleanup);
const hostId = "remote:server:source";
const project: VirtualProject = {
  id: "actual-created-id",
  hostId,
  name: "folder",
  nameOverridden: false,
  roots: [{ rootPath: "/remote/folder", isPrimary: true, position: 0 }],
  deleted: false,
  pinned: false,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
function setup(options: { deleted?: boolean; legacy?: boolean } = {}) {
  const host = {
    id: hostId,
    membershipId: "membership",
    kind: "server",
    target: { kind: "server", url: "https://remote.example.com" },
    position: 0,
  };
  fixture.hosts = [host];
  let projects = options.deleted
    ? [{ ...project, name: "Restored project", nameOverridden: true, deleted: true }]
    : [];
  const service = {
    readDirectory: vi.fn(async () => ({ path: "/remote/folder", entries: [] })),
    readTree: vi.fn(async () => ({ projects, tasks: [], legacySingleRoot: options.legacy })),
    saveProject: vi.fn<IProjectService["saveProject"]>(async (input) => {
      const saved = input.restoreProjectId
        ? {
            ...projects.find((candidate) => candidate.id === input.restoreProjectId)!,
            deleted: false,
          }
        : project;
      projects = [saved];
      return saved;
    }),
  };
  const remoteService = {
    readDirectory: vi.fn(async () => ({ hosts: fixture.hosts, entries: [] })),
    addEntry: vi.fn(async () => ({})),
  };
  const onCreateTask = vi.fn<ProjectSidebarProps["onCreateTask"]>((request) => {
    if (typeof request === "object") request.onComplete?.();
  });
  const onClose = vi.fn();
  let current = true;
  const view = render(
    createElement(
      Fragment,
      null,
      createElement(ConfirmDialogHost),
      createElement(ChatRemoteFolderSelection, {
        request: { sourceServerId: "source", isCurrent: () => current },
        service: service as unknown as IProjectService,
        remoteService: remoteService as unknown as IRemoteProjectService,
        onCreateTask,
        onClose,
      }),
    ),
  );
  return {
    ...view,
    service,
    remoteService,
    onCreateTask,
    onClose,
    invalidate: () => {
      current = false;
    },
  };
}
async function choose() {
  await waitFor(() =>
    expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
  return screen.findByTestId("virtual-project-name");
}
it("零匹配以固定目录和默认名称进入共享创建，信任后使用真实项目进入新草稿", async () => {
  const f = setup();
  expect(((await choose()) as HTMLInputElement).value).toBe("folder");
  expect(screen.queryByTestId("virtual-project-browse")).toBeNull();
  expect(screen.queryByTestId("virtual-project-remove-folder")).toBeNull();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await screen.findByTestId("project-folder-trust-dialog");
  expect(f.service.saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  await waitFor(() =>
    expect(f.onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, hostId }),
    ),
  );
  expect(f.service.saveProject).toHaveBeenCalledWith(
    expect.objectContaining({ hostId, roots: ["/remote/folder"], primaryRoot: "/remote/folder" }),
  );
  expect(f.remoteService.addEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedMembershipId: "membership",
      project: expect.objectContaining({ projectId: project.id }),
    }),
  );
});

it("登记失败仅重试同一个已保存 ID，不再次询问信任或保存", async () => {
  const f = setup();
  f.remoteService.addEntry.mockRejectedValueOnce(new Error("registration failed"));
  await choose();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("registration failed");
  expect(f.onCreateTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(f.onCreateTask).toHaveBeenCalledOnce());
  expect(f.service.saveProject).toHaveBeenCalledOnce();
  expect(f.remoteService.addEntry).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
});

it.each([true, false])("软删匹配沿用恢复选择，接受恢复=%s", async (restore) => {
  const f = setup({ deleted: true });
  await choose();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await screen.findByText("project.restore");
  fireEvent.click(
    screen.getByRole("button", { name: restore ? /common.confirm/ : /common.cancel/ }),
  );
  const trust = await screen.findByTestId("project-folder-trust-confirm");
  expect(trust.textContent).toBe(
    restore ? "project.trustFoldersAndRestore" : "project.trustFoldersAndCreate",
  );
  expect(
    within(screen.getByTestId("project-folder-trust-dialog")).getByText(
      restore ? "Restored project" : "folder",
    ),
  ).toBeTruthy();
  fireEvent.click(trust);
  await waitFor(() => expect(f.service.saveProject).toHaveBeenCalledOnce());
  expect(f.service.saveProject.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining(
      restore ? { restoreProjectId: project.id } : { roots: ["/remote/folder"] },
    ),
  );
  if (!restore)
    expect(f.service.saveProject.mock.calls[0]?.[0]).not.toHaveProperty("restoreProjectId");
});

it("嵌套信任取消保留选择，目录在确认后失效不会保存或登记", async () => {
  const f = setup();
  await choose();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.keyDown(await screen.findByTestId("project-folder-trust-dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull());
  expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe("folder");
  expect(f.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await screen.findByTestId("project-folder-trust-confirm");
  f.service.readDirectory.mockRejectedValueOnce(new Error("EACCES"));
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("EACCES");
  expect(f.service.saveProject).not.toHaveBeenCalled();
  expect(f.remoteService.addEntry).not.toHaveBeenCalled();
});

it("只读旧远端不能从零匹配创建", async () => {
  const f = setup({ legacy: true });
  await waitFor(() =>
    expect(screen.getByText("chat.remoteFolder.confirm").closest("button")!.disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("chat.remoteFolder.confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("project.legacyUpgradeRequired");
  expect(screen.queryByTestId("virtual-project-name")).toBeNull();
  expect(f.service.saveProject).not.toHaveBeenCalled();
});

it.each(["cancel", "owner", "membership"])("保存迟到后 %s 失效不登记或导航", async (kind) => {
  const f = setup();
  const pending = Promise.withResolvers<VirtualProject>();
  f.service.saveProject.mockImplementationOnce(() => pending.promise);
  await choose();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() => expect(f.service.saveProject).toHaveBeenCalledOnce());
  if (kind === "cancel") fireEvent.click(screen.getByText("project.cancel"));
  else if (kind === "owner") f.invalidate();
  else fixture.hosts = [];
  await act(async () => pending.resolve(project));
  expect(f.remoteService.addEntry).not.toHaveBeenCalled();
  expect(f.onCreateTask).not.toHaveBeenCalled();
});

it("创建查询迟到而请求已换代，不继续弹信任或写入", async () => {
  const f = setup();
  await choose();
  const pending = Promise.withResolvers<{
    projects: VirtualProject[];
    tasks: [];
    legacySingleRoot: undefined;
  }>();
  f.service.readTree.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  f.invalidate();
  await act(async () => pending.resolve({ projects: [], tasks: [], legacySingleRoot: undefined }));
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
  expect(f.service.saveProject).not.toHaveBeenCalled();
});

it("保存失败保留原选择，重试重新确认且双击只写入一次", async () => {
  const f = setup();
  f.service.saveProject.mockRejectedValueOnce(new Error("remote save unavailable"));
  await choose();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("remote save unavailable");
  expect(f.remoteService.addEntry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  const confirm = await screen.findByTestId("project-folder-trust-confirm");
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(f.onCreateTask).toHaveBeenCalledOnce());
  expect(f.service.saveProject).toHaveBeenCalledTimes(2);
  expect(f.remoteService.addEntry).toHaveBeenCalledOnce();
});
