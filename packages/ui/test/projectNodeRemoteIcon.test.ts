// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
afterEach(cleanup);

function fixture(): ProjectNodeProps {
  return {
    project: {
      id: "project",
      hostId: "remote:server:source",
      name: "Remote project",
      roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
      deleted: false,
      pinned: false,
      nameOverridden: false,
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    remoteHost: {
      id: "remote:server:source",
      membershipId: "member",
      kind: "ssh",
      target: { kind: "ssh", host: "example.test", username: "dev", port: 22 },
      connectionStatus: "online",
      lastConnectionStatus: "online",
      position: 0,
    },
    availability: { online: true },
    expanded: true,
    onExpandedChange: vi.fn(),
    tasks: [],
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
}

it("远程项目展开和收起均显示中性云，不显示本地文件夹", () => {
  const props = fixture();
  const view = render(createElement(ProjectNode, props), { wrapper: TooltipProvider });
  const toggle = screen.getByTestId("virtual-project-toggle");
  const expectCloud = () => {
    expect(toggle.querySelector('[data-remote-state-icon="cloud"]')).not.toBeNull();
    expect(toggle.querySelector('[data-remote-state-icon="cloud"]')?.classList).toContain(
      "text-remote-foreground-muted",
    );
    expect(toggle.querySelector(".lucide-folder, .lucide-folder-open")).toBeNull();
  };
  expectCloud();
  view.rerender(createElement(ProjectNode, { ...props, expanded: false }));
  expectCloud();
});

it.each([
  { state: "retrying", connectionStatus: "connecting", icon: "spinner" },
  { state: "offline", connectionStatus: "offline", icon: "cloud-off" },
  { state: "needs-upgrade", connectionStatus: "offline", icon: "cloud-alert" },
  { state: "identity-change-pending", connectionStatus: "offline", icon: "cloud-alert" },
  { state: "failed", connectionStatus: "offline", icon: "cloud-x" },
] as const)("远程连接 $state 使用既有五态图标 $icon", ({ state, connectionStatus, icon }) => {
  const props = fixture();
  const { container } = render(
    createElement(ProjectNode, {
      ...props,
      remoteHost: { ...props.remoteHost!, connectionStatus, lastConnectionStatus: state },
      availability: { online: false },
    }),
    { wrapper: TooltipProvider },
  );
  expect(
    screen
      .getByTestId("virtual-project-toggle")
      .querySelector(`[data-remote-state-icon="${icon}"]`),
  ).not.toBeNull();
  if (icon === "spinner") expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
});

it("Direct Server 不带 Source 详细状态时仍使用实时连接状态", () => {
  const props = fixture();
  render(
    createElement(ProjectNode, {
      ...props,
      remoteHost: {
        ...props.remoteHost!,
        kind: "server",
        target: { kind: "server", url: "https://example.test" },
        lastConnectionStatus: undefined,
      },
    }),
    { wrapper: TooltipProvider },
  );
  expect(
    screen.getByTestId("virtual-project-toggle").querySelector('[data-remote-state-icon="cloud"]'),
  ).not.toBeNull();
});

it.each([
  { name: "自动恢复", connectionStatus: "connecting", state: "retrying", online: false },
  { name: "设备在线但项目未就绪", connectionStatus: "online", state: "online", online: false },
] as const)(
  "$name 时设备名后显示“连接中”，不显示诊断图标，项目行只有一个转圈",
  ({ connectionStatus, state }) => {
    // 修复原因：connecting 曾落入“离线”分支，出现图标在转、文字写离线的矛盾。
    const props = fixture();
    const { container } = render(
      createElement(ProjectNode, {
        ...props,
        remoteHost: { ...props.remoteHost!, connectionStatus, lastConnectionStatus: state },
        availability: { online: false },
      }),
      { wrapper: TooltipProvider },
    );
    expect(screen.getByTestId("project-status-label").textContent).toBe("remote.status.connecting");
    expect(screen.queryByRole("button", { name: "remote.action.details" })).toBeNull();
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  },
);

it("连接失败时设备名后显示“连接失败”，不再显示额外错误图标", () => {
  const props = fixture();
  render(
    createElement(ProjectNode, {
      ...props,
      remoteHost: {
        ...props.remoteHost!,
        connectionStatus: "offline",
        lastConnectionStatus: "failed",
        lastConnectionError: "Connection refused",
      },
      availability: { online: false },
    }),
    { wrapper: TooltipProvider },
  );
  expect(screen.getByTestId("project-status-label").textContent).toBe("remote.status.failed");
  expect(screen.queryByTestId("project-connection-error")).toBeNull();
});

it.each([
  { state: "needs-upgrade", label: "remote.status.needsUpdate" },
  { state: "needs-install", label: "remote.status.needsInstall" },
  { state: "identity-change-pending", label: "remote.status.needsIdentity" },
] as const)("待处理 $state 在设备名后显示具体短状态，不显示离线", ({ state, label }) => {
  const props = fixture();
  render(
    createElement(ProjectNode, {
      ...props,
      remoteHost: {
        ...props.remoteHost!,
        connectionStatus: "offline",
        lastConnectionStatus: state,
      },
      availability: { online: false },
    }),
    { wrapper: TooltipProvider },
  );
  const status = screen.getByTestId("project-status-label");
  expect(status.textContent).toBe(label);
  expect(status.className).toContain("text-warning-surface-foreground");
});

it("普通离线仍显示离线", () => {
  const props = fixture();
  render(
    createElement(ProjectNode, {
      ...props,
      remoteHost: {
        ...props.remoteHost!,
        connectionStatus: "offline",
        lastConnectionStatus: "offline",
      },
      availability: { online: false },
    }),
    { wrapper: TooltipProvider },
  );
  expect(screen.getByTestId("project-status-label").textContent).toBe("project.offline");
});
