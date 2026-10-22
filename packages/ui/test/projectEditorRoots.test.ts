// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import {
  ProjectDirectoryProvider,
  useProjectDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";

const native = vi.hoisted(() => ({ select: undefined as undefined | (() => Promise<string[]>) }));
const readTree = vi.hoisted(() => vi.fn());
vi.mock("@/project-sidebar/useProjectTree.js", () => ({ useProjectTree: readTree }));
vi.mock("@/hooks/useSourceServerDisplayNames.js", () => ({
  useSourceServerDisplayNames: () => new Map(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ broadcastService: { onMessage: () => ({ dispose() {} }) } }),
  useOptionalBaseWorkspaceServices: () => null,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ selectDirectories: native.select, syncWindowUnreadCount: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/useProjectDirectoryServices.js", () => ({
  useProjectDirectoryServices: () => ({ services: {} }),
}));
vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: ({ onSelect }: { onSelect(path: string): void }) =>
    createElement("button", { onClick: () => onSelect("/source/added") }, "choose-root"),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn() }));
afterEach(() => {
  cleanup();
  native.select = undefined;
  localStorage.clear();
});

const project: VirtualProject = {
  id: "p",
  hostId: "local",
  name: "Project",
  nameOverridden: true,
  pinned: false,
  deleted: false,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  roots: [
    { rootPath: "/source/test-aaa", position: 0, isPrimary: true },
    { rootPath: "C:\\source\\test-bbb", position: 1, isPrimary: false },
  ],
};
function editor(value: VirtualProject | null = project, remove = vi.fn(async () => {})) {
  const saveProject = vi.fn(async () => project);
  const onClose = vi.fn();
  const onSaved = vi.fn(async () => {});
  const onDeleted = vi.fn(async () => {});
  render(
    createElement(ProjectEditor, {
      project: value,
      projects: [],
      service: { saveProject, deleteProject: remove } as never,
      onClose,
      onSaved,
      onDeleted,
    }),
  );
  return { saveProject, onClose, onSaved, onDeleted, remove };
}

it("switches from empty add area to folder rows and returns to empty after removing the last root", async () => {
  editor(null);
  expect(screen.queryByTestId("virtual-project-editor-delete")).toBeNull();
  expect(screen.getByTestId("virtual-project-browse").textContent).toBe(
    "project.browseproject.browseHint",
  );
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  const list = screen.getByTestId("virtual-project-roots");
  expect(within(list).getByTestId("virtual-project-browse").textContent).toBe(
    "project.addSourceFolder",
  );
  expect(within(list).getByTitle("/source/added").textContent).toBe("added");
  expect(within(list).getByTestId("virtual-project-primary").textContent).toBe(
    "project.primaryBadge",
  );
  fireEvent.click(within(list).getByRole("button", { name: "project.removeFolder" }));
  expect(screen.queryByTestId("virtual-project-roots")).toBeNull();
  expect(screen.getByTestId("virtual-project-browse").textContent).toBe(
    "project.browseproject.browseHint",
  );
});

it("sets the primary folder in the draft and sends it only when saving", async () => {
  const { saveProject, onSaved } = editor();
  expect(screen.getByTitle("C:\\source\\test-bbb").textContent).toBe("test-bbb");
  fireEvent.click(screen.getByRole("button", { name: "project.setPrimary" }));
  expect(saveProject).not.toHaveBeenCalled();
  const rows = screen.getAllByTestId("virtual-project-root-row");
  expect(within(rows[1]!).getByTestId("virtual-project-primary")).toBeTruthy();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(project));
  expect(saveProject).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "p",
      hostId: "local",
      roots: ["/source/test-aaa", "C:\\source\\test-bbb"],
      primaryRoot: "C:\\source\\test-bbb",
    }),
  );
});

it("falls back to the first remaining folder after removing primary, and cancel does not persist", () => {
  const { saveProject, onClose } = editor();
  fireEvent.click(screen.getByRole("button", { name: "project.setPrimary" }));
  fireEvent.click(
    within(screen.getAllByTestId("virtual-project-root-row")[1]!).getByRole("button", {
      name: "project.removeFolder",
    }),
  );
  expect(
    within(screen.getAllByTestId("virtual-project-root-row")[0]!).getByTestId(
      "virtual-project-primary",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.cancel" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(saveProject).not.toHaveBeenCalled();
});

it.each(["local", "remote:server:source"])(
  "deletes only the project on its owner %s before refreshing and closing",
  async (hostId) => {
    let finish!: () => void;
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onDeleted, onClose, saveProject } = editor({ ...project, hostId }, remove);
    fireEvent.click(screen.getByTestId("virtual-project-editor-delete"));
    expect(remove).toHaveBeenCalledWith("p", hostId);
    expect(screen.getByTestId("virtual-project-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("virtual-project-editor-delete").hasAttribute("disabled")).toBe(true);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]!,
    );
    expect(saveProject).not.toHaveBeenCalled();
  },
);

it("keeps the editor open on a failed remote deletion without saving the draft", async () => {
  const { onDeleted, onClose, saveProject } = editor(
    { ...project, hostId: "remote:server:source" },
    vi.fn(async () => {
      throw new Error("connection lost");
    }),
  );
  fireEvent.click(screen.getByTestId("virtual-project-editor-delete"));
  expect((await screen.findByRole("alert")).textContent).toContain("connection lost");
  expect(onDeleted).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
  expect(screen.getByTestId("virtual-project-editor-delete").hasAttribute("disabled")).toBe(false);
});

it.each(["local", "remote:server:source"])(
  "keeps shared project order stable after deleting on %s while the directory is stale",
  async (hostId) => {
    const target = { ...project, hostId };
    const items = [
      { ...project, id: "first", position: 0 },
      { ...target, position: 1 },
      { ...project, hostId: hostId === "local" ? "remote:server:source" : "local", position: 2 },
    ];
    const tree = { projects: items, tasks: [] };
    readTree.mockReturnValue({ tree, factTree: tree, loading: false });
    let finish!: () => void;
    const refreshed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onDeleted = vi.fn(() => refreshed);
    const deleteProject = vi.fn(async () => {});
    const onClose = vi.fn();
    function Consumer({ name }: { name: string }) {
      const { projects } = useProjectDirectory();
      return createElement(
        "output",
        { "data-testid": name },
        projects.map((item) => `${item.hostId}/${item.id}`).join(","),
      );
    }
    const content = () =>
      createElement(
        ProjectDirectoryProvider,
        null,
        createElement(Consumer, { name: "sidebar-order" }),
        createElement(Consumer, { name: "composer-order" }),
        createElement(ProjectEditor, {
          project: target,
          projects: items,
          service: { deleteProject } as never,
          onClose,
          onSaved: vi.fn(),
          onDeleted,
        }),
      );
    const { rerender } = render(content());
    const before = screen.getByTestId("sidebar-order").textContent;
    fireEvent.click(screen.getByTestId("virtual-project-editor-delete"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(deleteProject).toHaveBeenCalledWith(target.id, hostId);
    expect(screen.getByTestId("sidebar-order").textContent).toBe(before);
    expect(screen.getByTestId("composer-order").textContent).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    // 目录读取失败会保留旧快照；命令结束也不能把目标追加到末尾。
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sidebar-order").textContent).toBe(before);
    // 下一次权威刷新才移除目标，同 ID 的另一 Host 项目保持原位置。
    const remaining = [items[0]!, items[2]!];
    const nextTree = { projects: remaining, tasks: [] };
    readTree.mockReturnValue({ tree: nextTree, factTree: nextTree, loading: false });
    rerender(content());
    const after = remaining.map((item) => `${item.hostId}/${item.id}`).join(",");
    expect(screen.getByTestId("sidebar-order").textContent).toBe(after);
    expect(screen.getByTestId("composer-order").textContent).toBe(after);
  },
);

it("adds all native selections once to a new local project and keeps the first primary", async () => {
  native.select = vi.fn(async () => ["/source/one", "/source/two", "/source/one"]);
  const { saveProject } = editor(null);
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await screen.findByTitle("/source/two");
  expect(screen.queryByTestId("virtual-project-directory-browser")).toBeNull();
  expect(screen.getAllByTestId("virtual-project-root-row")).toHaveLength(2);
  expect(
    within(screen.getAllByTestId("virtual-project-root-row")[0]!).getByTestId(
      "virtual-project-primary",
    ),
  ).toBeTruthy();
  expect(saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() =>
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        roots: ["/source/one", "/source/two"],
        primaryRoot: "/source/one",
      }),
    ),
  );
});

it("appends native roots without duplicates or changing the existing primary, and cancel is a no-op", async () => {
  const select = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValueOnce(["/source/test-aaa", "/source/three"])
    .mockResolvedValueOnce([]);
  native.select = select;
  const { saveProject, onClose } = editor();
  fireEvent.click(screen.getByRole("button", { name: "project.setPrimary" }));
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await screen.findByTitle("/source/three");
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await waitFor(() =>
    expect(screen.getByTestId("virtual-project-save").hasAttribute("disabled")).toBe(false),
  );
  expect(select).toHaveBeenCalledTimes(2);
  expect(screen.getAllByTestId("virtual-project-root-row")).toHaveLength(3);
  expect(
    within(screen.getAllByTestId("virtual-project-root-row")[1]!).getByTestId(
      "virtual-project-primary",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(saveProject).not.toHaveBeenCalled();
});

it("blocks save and close while the native picker is open, then preserves the draft on failure and permits retry", async () => {
  let fail!: (error: Error) => void;
  const select = vi
    .fn<() => Promise<string[]>>()
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValueOnce(["/source/retry"]);
  native.select = select;
  const { saveProject, onClose } = editor();
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  expect(screen.getByTestId("virtual-project-save").hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("virtual-project-editor-delete").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(screen.getByRole("button", { name: "project.cancel" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
  await act(async () => fail(new Error("picker failed")));
  expect((await screen.findByRole("alert")).textContent).toContain("picker failed");
  expect(screen.getAllByTestId("virtual-project-root-row")).toHaveLength(2);
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await screen.findByTitle("/source/retry");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("remote root remains immutable even when native selection is available", async () => {
  native.select = vi.fn(async () => ["/wrong/local"]);
  const fixed = {
    ...project,
    hostId: "remote:server:source",
    roots: [{ rootPath: "/source/fixed", position: 0, isPrimary: true }],
  };
  const { saveProject } = editor(fixed);
  expect(screen.queryByTestId("virtual-project-browse")).toBeNull();
  expect(native.select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() =>
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: fixed.hostId, roots: ["/source/fixed"] }),
    ),
  );
});
