// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/useProjectDirectoryServices.js", () => ({
  useProjectDirectoryServices: () => ({ services: {} }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
afterEach(cleanup);

const paths = ["/source/one", "C:\\source\\folder with spaces"];
const saved: VirtualProject = {
  id: "saved",
  hostId: "local",
  name: "Draft",
  nameOverridden: true,
  roots: paths.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
  pinned: false,
  deleted: false,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
function setup(
  options: { roots?: string[]; project?: VirtualProject; projects?: VirtualProject[] } = {},
) {
  const saveProject = vi.fn(async () => saved);
  const props = {
    project: options.project ?? null,
    initialRoots: options.roots ?? paths,
    projects: options.projects ?? [],
    service: { saveProject } as never,
    onBeforeSave: vi.fn(async () => {}),
    onSaved: vi.fn(async () => {}),
    onClose: vi.fn(),
    suspended: false,
  };
  return { ...render(createElement(ProjectEditor, props)), props, saveProject };
}
async function requestTrust() {
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  return screen.findByTestId("project-folder-trust-dialog");
}

it("shows all selected paths and does not register a Host or save until explicit trust", async () => {
  const { props, saveProject } = setup();
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Review me" } });
  const dialog = await requestTrust();
  for (const path of paths) expect(within(dialog).getByText(path)).toBeTruthy();
  expect(within(dialog).getByText("project.thisComputer")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByTestId("project-folder-trust-cancel"));
  fireEvent.keyDown(dialog, { key: "Enter" });
  expect(saveProject).not.toHaveBeenCalled();
  expect(props.onBeforeSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
  expect(saveProject).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Review me", roots: paths, primaryRoot: paths[0] }),
  );
  expect(props.onBeforeSave.mock.invocationCallOrder[0]).toBeLessThan(
    saveProject.mock.invocationCallOrder[0]!,
  );
});

it.each(["cancel", "close", "escape"])(
  "%s returns to the intact form without creating",
  async (action) => {
    const { props, saveProject } = setup();
    fireEvent.change(screen.getByTestId("virtual-project-name"), {
      target: { value: "Preserved" },
    });
    const dialog = await requestTrust();
    if (action === "cancel") fireEvent.click(screen.getByTestId("project-folder-trust-cancel"));
    else if (action === "close")
      fireEvent.click(within(dialog).getByRole("button", { name: "common.close" }));
    else fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull());
    expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe(
      "Preserved",
    );
    expect(screen.getAllByTestId("virtual-project-root-row")).toHaveLength(2);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("virtual-project-save")),
    );
    expect(saveProject).not.toHaveBeenCalled();
    expect(props.onBeforeSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  },
);

it("skips confirmation for an empty local project and for editing an existing project", async () => {
  const empty = setup({ roots: [] });
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(empty.saveProject).toHaveBeenCalledOnce());
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
  cleanup();
  const edited = setup({ project: saved });
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(edited.saveProject).toHaveBeenCalledOnce());
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
});

it("touch cancellation closes only the trust dialog and preserves the parent editor", async () => {
  const { props, saveProject } = setup();
  await requestTrust();
  // Radix 在触摸 pointerdown 后等 click 才判断外部点击，单独 fireEvent.click 无法复现。
  const cancel = screen.getByTestId("project-folder-trust-cancel");
  const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
  fireEvent(cancel, pointerDown);
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull());
  expect(props.onClose).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
  expect(screen.getByTestId("virtual-project-name")).toBeTruthy();
});

it("does not reuse another project's folders as approval, and asks again after a save failure", async () => {
  const { saveProject } = setup({ projects: [saved] });
  saveProject.mockRejectedValueOnce(new Error("directory unavailable"));
  await requestTrust();
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("directory unavailable");
  await requestTrust();
  expect(saveProject).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2));
});

it("confirms a restore before changing the deleted project", async () => {
  const { saveProject } = setup({ projects: [{ ...saved, deleted: true }] });
  await requestTrust();
  expect(screen.getByTestId("project-folder-trust-confirm").textContent).toBe(
    "project.trustFoldersAndRestore",
  );
  expect(saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("project-folder-trust-confirm"));
  await waitFor(() =>
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ restoreProjectId: saved.id }),
    ),
  );
});

it("cancels hidden/unmounted confirmation and does not accept an old button callback", async () => {
  const { props, saveProject, rerender, unmount } = setup();
  await requestTrust();
  const oldButton = screen.getByTestId("project-folder-trust-confirm");
  rerender(createElement(ProjectEditor, { ...props, suspended: true }));
  await act(async () => {});
  fireEvent.click(oldButton);
  expect(saveProject).not.toHaveBeenCalled();
  rerender(createElement(ProjectEditor, props));
  await requestTrust();
  unmount();
  await act(async () => {});
  expect(saveProject).not.toHaveBeenCalled();
  expect(props.onBeforeSave).not.toHaveBeenCalled();
});

it("commits once on rapid activation and retries registration without another trust or project", async () => {
  const admission = Promise.withResolvers<void>();
  const { props, saveProject } = setup();
  props.onBeforeSave.mockImplementationOnce(() => admission.promise);
  props.onSaved.mockRejectedValueOnce(new Error("registration failed"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  const button = await screen.findByTestId("project-folder-trust-confirm");
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => {});
  expect(props.onBeforeSave).toHaveBeenCalledOnce();
  await act(async () => admission.resolve());
  expect((await screen.findByRole("alert")).textContent).toContain("registration failed");
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(2));
  expect(saveProject).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
});

it("invalidates a remote preparation that finishes after hiding and reopening the form", async () => {
  const tree = Promise.withResolvers<{ projects: VirtualProject[]; tasks: [] }>();
  const { props, saveProject } = setup({ roots: [paths[0]!] });
  const remoteProps = {
    ...props,
    defaultDeviceId: "remote:server:source",
    devices: [{ id: "remote:server:source", label: "Selected device", status: "online" }],
    service: { saveProject, readTree: () => tree.promise } as never,
  };
  cleanup();
  const view = render(createElement(ProjectEditor, remoteProps));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  view.rerender(createElement(ProjectEditor, { ...remoteProps, suspended: true }));
  view.rerender(createElement(ProjectEditor, remoteProps));
  await act(async () => tree.resolve({ projects: [], tasks: [] }));
  expect(screen.queryByTestId("project-folder-trust-dialog")).toBeNull();
  expect(props.onBeforeSave).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
});
