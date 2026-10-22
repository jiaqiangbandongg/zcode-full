// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => null }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn() }));
vi.mock("@/project-sidebar/useProjectDirectoryServices.js", () => ({
  useProjectDirectoryServices: () => ({ services: null }),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => null,
}));
afterEach(cleanup);
const base = { projects: [], service: {} as never, onClose: vi.fn(), onSaved: vi.fn() };
it("remote creation requires selecting its directory before save", () => {
  render(
    createElement(ProjectEditor, {
      ...base,
      project: null,
      host: { id: "remote:server:s" } as never,
    }),
  );
  expect((screen.getByTestId("virtual-project-save") as HTMLButtonElement).disabled).toBe(true);
});
it("remote edit exposes neither replacement nor extra directories", () => {
  render(
    createElement(ProjectEditor, {
      ...base,
      project: {
        id: "p",
        hostId: "remote:server:s",
        name: "P",
        roots: [{ rootPath: "/repo", isPrimary: true, position: 0 }],
      } as never,
    }),
  );
  expect(screen.queryByTestId("virtual-project-browse")).toBeNull();
  expect(screen.queryByTestId("virtual-project-remove-folder")).toBeNull();
  expect(screen.queryByTestId("virtual-project-set-primary")).toBeNull();
  expect((screen.getByTestId("virtual-project-save") as HTMLButtonElement).disabled).toBe(false);
});
it("local empty projects still permit creation", () => {
  render(createElement(ProjectEditor, { ...base, project: null }));
  expect((screen.getByTestId("virtual-project-save") as HTMLButtonElement).disabled).toBe(false);
});
