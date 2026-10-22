// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { SaveProjectInput } from "@/project-sidebar/contract.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/useProjectDirectoryServices.js", () => ({
  useProjectDirectoryServices: () => ({ services: {}, error: null }),
}));
vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: ({ onSelect }: { onSelect(path: string): void }) =>
    createElement("button", { onClick: () => onSelect("/remote/root") }, "choose-remote-root"),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
afterEach(cleanup);
it("creates on the explicitly selected Host and returns the authoritative project for adding an entry", async () => {
  const project = { id: "remote-p", hostId: "remote:server:s", roots: [], name: "Remote" };
  const saveProject = vi.fn(async () => project);
  const onSaved = vi.fn(async () => {});
  render(
    createElement(ProjectEditor, {
      project: null,
      host: { id: project.hostId, membershipId: "m", kind: "server", target: null, position: 0 },
      projects: [],
      service: { saveProject } as never,
      onClose: vi.fn(),
      onSaved,
    }),
  );
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-remote-root"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(project));
  expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({ hostId: project.hostId }));
  expect(saveProject).toHaveBeenCalledWith(
    expect.objectContaining({ roots: ["/remote/root"], primaryRoot: "/remote/root" }),
  );
});
it("restores the selected service owner's project without forcing a local Host", async () => {
  const saveProject = vi.fn(async (_input: SaveProjectInput) => ({}));
  render(
    createElement(ProjectEditor, {
      project: null,
      projects: [
        {
          id: "restore",
          hostId: "remote:server:s",
          name: "Old",
          roots: [],
          deleted: true,
          pinned: false,
          position: 1,
          nameOverridden: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      service: { saveProject } as never,
      onClose: vi.fn(),
      onSaved: async () => {},
    }),
  );
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() =>
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ restoreProjectId: "restore" }),
    ),
  );
  expect(saveProject.mock.calls[0]?.[0]).not.toHaveProperty("hostId");
});

it("does not close a replacement draft when an earlier entry registration finishes late", async () => {
  const registration = Promise.withResolvers<void>();
  const onSaved = vi.fn(() => registration.promise);
  const onClose = vi.fn();
  const props = {
    project: null,
    projects: [],
    service: {
      saveProject: async () => ({ id: "saved", hostId: "local", name: "Old", roots: [] }),
    } as never,
    onClose,
    onSaved,
  };
  const { unmount } = render(createElement(ProjectEditor, props));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  unmount();
  render(createElement(ProjectEditor, props));
  await act(async () => registration.resolve());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId("virtual-project-name")).toBeTruthy();
});
