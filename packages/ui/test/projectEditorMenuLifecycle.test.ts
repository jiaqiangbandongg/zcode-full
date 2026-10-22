// @vitest-environment jsdom
import { createElement, useState } from "react";
import {
  cleanup,
  fireEvent,
  render as renderWithContext,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ReactNode } from "react";
const render = (node: ReactNode) => renderWithContext(node, { wrapper: TooltipProvider });
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => null }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.pointerEvents = "";
});
it.each(["context", "dropdown"])(
  "releases modal pointer ownership after editing from the %s menu",
  async (entry) => {
    function Fixture() {
      const [editing, setEditing] = useState(false);
      const [project, setProject] = useState<VirtualProject>({
        id: "p",
        hostId: "local",
        name: "Project",
        roots: [],
        nameOverridden: false,
        pinned: false,
        deleted: false,
        position: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return createElement(
        "div",
        {},
        createElement(ProjectNode, {
          expanded: true,
          onExpandedChange: vi.fn(),
          project,
          tasks: [],
          onCreate: vi.fn(),
          onEdit: () => setEditing(true),
          onDelete: vi.fn(),
          onPin: vi.fn(),
          onMove: vi.fn(),
          onSelect: vi.fn(),
          refresh: async () => {},
        }),
        editing
          ? createElement(ProjectEditor, {
              project,
              projects: [project],
              service: { saveProject: async () => ({ ...project, name: "Renamed" }) } as never,
              onClose: () => setEditing(false),
              onSaved: async (saved) => {
                setProject(saved);
              },
            })
          : null,
      );
    }
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const style = document.createElement("style");
    style.textContent =
      '[role="menu"][data-state="open"] { animation-name: menu-open; } [role="menu"][data-state="closed"] { animation-name: menu-close; }';
    document.head.appendChild(style);
    render(createElement(Fixture));
    if (entry === "context") fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
    else fireEvent.keyDown(screen.getByTestId("virtual-project-menu"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByTestId("virtual-project-edit"));
    const save = await screen.findByTestId("virtual-project-save");
    expect(document.body.style.pointerEvents).toBe("none");
    const exitingMenu = document.querySelector('[role="menu"][data-state="closed"]');
    expect(exitingMenu).not.toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "menu-close" });
    fireEvent(exitingMenu!, end);
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(document.body.style.pointerEvents).not.toBe("none");
    style.remove();
  },
);
