// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
afterEach(cleanup);
function props(id: string): ProjectNodeProps {
  return {
    project: {
      id: "same-project",
      hostId: `remote:server:${id}`,
      name: "Project",
      roots: [{ rootPath: "/same", position: 0, isPrimary: true }],
      pinned: false,
      deleted: false,
      nameOverridden: true,
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    remoteHost: {
      id: `remote:server:${id}`,
      membershipId: id,
      kind: "server",
      target: { kind: "server", name: id, url: `https://${id}.test` },
      connectionStatus: "offline",
      position: 0,
    },
    deviceLabel: id,
    expanded: false,
    onExpandedChange: vi.fn(),
    tasks: [],
    availability: { online: false, entryId: id },
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh: vi.fn(async () => {}),
    onRemoveEntry: vi.fn(),
  };
}
it("同路径同项目 ID 的设备标识分开显示，移除仅作用于所选项目入口", async () => {
  const alpha = props("Alpha"),
    beta = props("Beta");
  const { container } = render(
    createElement(
      TooltipProvider,
      null,
      createElement(ProjectNode, alpha),
      createElement(ProjectNode, beta),
    ),
  );
  expect(screen.getAllByTestId("project-device").map((node) => node.textContent)).toEqual([
    "Alpha",
    "Beta",
  ]);
  expect(container.querySelector('[data-testid="remote-project-host"]')).toBeNull();
  const row = container.querySelector('[data-project-host="remote:server:Beta"]') as HTMLElement;
  expect(row.dataset.projectWorkspaceIdentity).toBe("remote:server:Beta:/same");
  expect(row.dataset.connectionState).toBe("offline");
  fireEvent.keyDown(within(row).getByTestId("virtual-project-menu"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "project.removeEntry" }));
  expect(beta.onRemoveEntry).toHaveBeenCalledOnce();
  expect(alpha.onRemoveEntry).not.toHaveBeenCalled();
});
