// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render as renderWithContext, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ReactNode } from "react";
const render = (node: ReactNode) => renderWithContext(node, { wrapper: TooltipProvider });
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({
  ProjectTaskRows: () => createElement("div", { "data-testid": "remote-task-facts" }),
}));
afterEach(cleanup);
describe("offline remote project", () => {
  it.each([false, true])(
    "remote control=%s keeps expansion but gates project sorting",
    (isWebRemoteControl) => {
      const { container } = render(
        createElement(
          ProjectTaskListContext.Provider,
          { value: { isWebRemoteControl } },
          createElement(ProjectNode, {
            expanded: true,
            onExpandedChange: vi.fn(),
            project: {
              id: "legacy-single-root:a",
              hostId: "remote:server:s",
              name: "a",
              roots: [{ rootPath: "/a", position: 0, isPrimary: true }],
              legacySingleRoot: true,
              deleted: false,
              pinned: false,
              nameOverridden: false,
              position: 0,
              createdAt: 0,
              updatedAt: 0,
            },
            availability: { online: true, entryId: "entry" },
            tasks: [],
            onCreate: vi.fn(),
            onEdit: vi.fn(),
            onDelete: vi.fn(),
            onRemoveEntry: vi.fn(),
            onPin: vi.fn(),
            onMove: vi.fn(),
            onSelect: vi.fn(),
            refresh: vi.fn(async () => {}),
          }),
        ),
      );
      expect(screen.getByTestId("virtual-project-toggle").hasAttribute("disabled")).toBe(false);
      expect(screen.queryByTestId("virtual-project-create-task")).not.toBeNull();
      expect(container.querySelector('[draggable="true"]')).toBeNull();
      // 标题仍可展开；aria-disabled 表达标题可用性，排序禁用由 useSortable.disabled 控制。
      expect(screen.getByTestId("virtual-project-toggle").getAttribute("aria-disabled")).toBe(
        "false",
      );
      expect(screen.queryByTestId("virtual-project-menu")).not.toBeNull();
      expect(
        screen.getByTestId("virtual-project-toggle").getAttribute("aria-roledescription"),
      ).toBe(isWebRemoteControl ? null : "sortable");
      expect(screen.getByTestId("virtual-project-toggle").className).toContain(
        isWebRemoteControl ? "touch-pan-y" : "touch-none",
      );
      fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
      expect(screen.queryByTestId("virtual-project-edit")).toBeNull();
      expect(screen.getByTestId("virtual-project-remove-entry")).toBeDefined();
    },
  );
  it("does not expose expansion, creation or cached task facts when its owner is offline", () => {
    render(
      createElement(ProjectNode, {
        expanded: true,
        onExpandedChange: vi.fn(),
        project: {
          id: "p",
          hostId: "remote:server:s",
          name: "Remote",
          roots: [],
          deleted: false,
          pinned: false,
          nameOverridden: false,
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        availability: { online: false, entryId: "entry" },
        tasks: [],
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onRemoveEntry: vi.fn(),
        onPin: vi.fn(),
        onMove: vi.fn(),
        onSelect: vi.fn(),
        refresh: vi.fn(async () => {}),
      }),
    );
    expect(screen.getByTestId("virtual-project-toggle").hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("virtual-project-create-task")).toBeNull();
    expect(screen.queryByTestId("remote-task-facts")).toBeNull();
  });
});
