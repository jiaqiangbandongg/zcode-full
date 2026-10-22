// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
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
it("连接状态刷新保留项目行菜单焦点，连接操作继续走现有连接入口", async () => {
  const connect = vi.fn();
  const input = {
    ...props("Alpha"),
    additionalActions: [{ id: "connect", label: "Connect", run: connect }],
  };
  // 详情打开后会读取基础服务上下文；URL Server 不使用 Source 管理服务，但仍需真实 Provider。
  const services = {} as IServiceAccessor;
  const child = (p: ProjectNodeProps) =>
    createElement(ServiceProvider, {
      services,
      children: createElement(TooltipProvider, null, createElement(ProjectNode, p)),
    });
  const view = render(child(input));
  // 菜单焦点会延迟打开详情；显式等待挂载，避免快速结束测试掩盖详情的服务依赖错误。
  fireEvent.focus(screen.getByTestId("virtual-project-menu"));
  expect((await screen.findByTestId("remote-identity-details")).textContent).toContain("Alpha");
  fireEvent.keyDown(screen.getByTestId("virtual-project-menu"), { key: "ArrowDown" });
  const action = await screen.findByRole("menuitem", { name: "Connect" });
  action.focus();
  view.rerender(
    child({ ...input, remoteHost: { ...input.remoteHost!, connectionStatus: "connecting" } }),
  );
  expect(document.activeElement).toBe(action);
  expect(screen.getByTestId("project-device").textContent).toBe("Alpha");
  fireEvent.click(action);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
});
