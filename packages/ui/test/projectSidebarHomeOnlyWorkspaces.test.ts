// @vitest-environment jsdom
import { createElement, Fragment, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";

const Sidebar = (props: ProjectSidebarProps) =>
  createElement(
    TooltipProvider,
    null,
    createElement(ProjectDirectoryProvider, null, createElement(WorkspaceSidebar, props)),
  );

const fixture = vi.hoisted(() => ({
  state: { tabs: [], activeWorkspaceIdentity: null, openSettingsTab: () => {} },
  hasProjectService: false,
  toast: vi.fn(),
  renderSidebar: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const projectService = { readTree: async () => ({ projects: [], tasks: [] }) };
  const remoteProjectService = { readDirectory: async () => ({ hosts: [], entries: [] }) };
  const base = {
    get projectService() {
      return fixture.hasProjectService ? projectService : undefined;
    },
    get remoteProjectService() {
      return fixture.hasProjectService ? remoteProjectService : undefined;
    },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose() {} }) },
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  };
  return { useBaseWorkspaceServices: () => base };
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  useOptionalTabStore: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  // 项目目录的未读监听使用原 store 的订阅接口，首页夹具也需提供可释放的订阅。
  useTabStoreApi: () => ({ getState: () => fixture.state, subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: () => true,
  useZCodeStore: (selector: (state: unknown) => unknown) => selector({ setTheme: () => {} }),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    localePreference: "en-US",
    setLocalePreference: () => {},
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: fixture.toast }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/hooks/usePlatform.js", () => ({
  useSelectDirectory: () => () => {},
  useOptionalPlatform: () => null,
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: () => {} }),
}));
vi.mock("@/components/manual-claim-plan/ManualClaimPlanBanner.js", () => ({
  ManualClaimPlanBanner: () => null,
}));
vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => createElement("footer", {}, "Footer"),
}));
vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: () => createElement("button", {}, "New task"),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
vi.mock("@/project-sidebar/useProjectTaskNavigation.js", () => ({
  useProjectTaskNavigation: (props: ProjectSidebarProps) => {
    fixture.renderSidebar();
    return props.onSelectTask;
  },
}));

const offline: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/srv/app",
  workspaceIdentity: "remote:ssh:dev:/srv/app",
  label: "Remote app",
  kind: "remote",
  connectionState: "disconnected",
};
const online: WebRemoteControlWorkspaceTarget = {
  ...offline,
  connectionState: "connected",
  remoteSessionId: "session-1",
};
const local: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/Users/dev/local",
  label: "Local app",
  kind: "local",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSwitcher(...results: Array<Promise<WebRemoteControlWorkspaceListResult>>) {
  let push: ((result: WebRemoteControlWorkspaceListResult) => void) | undefined;
  const switcher = {
    listWorkspaces: vi.fn(() => results.shift() ?? Promise.resolve({ workspaces: [] })),
    onWorkspaceListUpdated: vi.fn((listener: typeof push) => {
      push = listener;
      return () => {
        push = undefined;
      };
    }),
    switchWorkspace: vi.fn(async () => {}),
    reconnectWorkspace: vi.fn(async () => {}),
  };
  return { switcher, push: (result: WebRemoteControlWorkspaceListResult) => push?.(result) };
}

function props(
  switcher: ReturnType<typeof createSwitcher>["switcher"],
  overrides: Partial<ProjectSidebarProps> = {},
): ProjectSidebarProps {
  return {
    workspacePath: "remote:ssh:dev:/srv/app",
    theme: "light",
    isWebRemoteControl: true,
    webRemoteControlWorkspaceSwitcher: switcher as unknown as NonNullable<
      ProjectSidebarProps["webRemoteControlWorkspaceSwitcher"]
    >,
    onSelectTask: vi.fn(),
    onCreateTask: vi.fn(),
    onCreateConversationTask: vi.fn(),
    onStartDraftInWorkspace: vi.fn(),
    onOpenFolderFromWorkspaceMenu: vi.fn(),
    onConnectRemote: vi.fn(async () => "logical"),
    onSelectRemoteProject: vi.fn(async () => {}),
    onCancelRemoteProject: vi.fn(async () => {}),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    onOpenCommandCenter: vi.fn(),
    ...overrides,
  };
}

const row = (label: string) =>
  screen.getByText(label).closest("[data-home-only-workspace]") as HTMLButtonElement;

beforeEach(() => {
  fixture.hasProjectService = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectSidebar home-only workspace list", () => {
  it("skips unrelated parent updates but accepts changed navigation props", async () => {
    const { switcher } = createSwitcher(Promise.resolve({ workspaces: [local] }));
    const stableProps = props(switcher);
    function Parent() {
      const [revision, update] = useState(0);
      const [onCreateTask, setOnCreateTask] = useState(() => stableProps.onCreateTask);
      return createElement(
        Fragment,
        null,
        createElement("button", { onClick: () => update(revision + 1) }, "Unrelated update"),
        createElement(
          "button",
          { onClick: () => setOnCreateTask(() => vi.fn()) },
          "Navigation update",
        ),
        createElement(WorkspaceSidebar, { ...stableProps, onCreateTask }),
      );
    }
    // 目录 Provider 不属于面板开关 owner；不要让夹具父更新重建 mock 服务/context。
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProjectDirectoryProvider, null, createElement(Parent)),
      ),
    );
    await screen.findByText("Local app");
    fixture.renderSidebar.mockClear();
    fireEvent.click(screen.getByText("Unrelated update"));
    expect(fixture.renderSidebar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Navigation update"));
    expect(fixture.renderSidebar).toHaveBeenCalled();
  });

  it("lists desktop workspaces instead of the unavailable project tree", async () => {
    const { switcher } = createSwitcher(Promise.resolve({ workspaces: [offline, local] }));
    render(createElement(Sidebar, props(switcher)));

    await screen.findByText("Remote app");
    expect(screen.getByText("webRemoteControl.homeOnlyWorkspaces")).toBeTruthy();
    expect(row("Remote app").textContent).toContain("remote.status.offline");
    expect(row("Remote app").textContent).toContain("remote.action.connect");
    expect(row("Local app").textContent).not.toContain("remote.action.connect");
    expect(screen.queryByText(/project\.service-unavailable/)).toBeNull();
    expect(screen.queryByText("project.projects")).toBeNull();
  });

  it("reconnects a disconnected workspace, reloads the list, then opens it after it can bridge", async () => {
    const { switcher } = createSwitcher(
      Promise.resolve({ workspaces: [offline] }),
      Promise.resolve({ workspaces: [online] }),
    );
    render(createElement(Sidebar, props(switcher)));

    fireEvent.click(await screen.findByText("Remote app"));
    await waitFor(() =>
      expect(switcher.reconnectWorkspace).toHaveBeenCalledWith("remote:ssh:dev:/srv/app"),
    );
    await waitFor(() => expect(row("Remote app").textContent).toContain("remote.status.online"));
    expect(switcher.listWorkspaces).toHaveBeenCalledTimes(2);
    expect(switcher.switchWorkspace).not.toHaveBeenCalled();

    fireEvent.click(row("Remote app"));
    await waitFor(() =>
      expect(switcher.switchWorkspace).toHaveBeenCalledWith("remote:ssh:dev:/srv/app"),
    );
    expect(switcher.reconnectWorkspace).toHaveBeenCalledOnce();
  });

  it("opens a local workspace directly through the switcher", async () => {
    const { switcher } = createSwitcher(Promise.resolve({ workspaces: [local] }));
    render(createElement(Sidebar, props(switcher)));

    fireEvent.click(await screen.findByText("Local app"));
    await waitFor(() => expect(switcher.switchWorkspace).toHaveBeenCalledWith("/Users/dev/local"));
    expect(switcher.reconnectWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a pushed update when an older list response arrives late", async () => {
    const pending = deferred<WebRemoteControlWorkspaceListResult>();
    const { switcher, push } = createSwitcher(pending.promise);
    render(createElement(Sidebar, props(switcher)));

    act(() => push({ workspaces: [online] }));
    await screen.findByText("Remote app");
    await act(async () => pending.resolve({ workspaces: [offline] }));

    expect(row("Remote app").textContent).toContain("remote.status.online");
  });

  it("disables a workspace that the desktop is reconnecting", async () => {
    const { switcher } = createSwitcher(
      Promise.resolve({ workspaces: [{ ...offline, connectionState: "reconnecting" }] }),
    );
    render(createElement(Sidebar, props(switcher)));

    await screen.findByText("Remote app");
    expect(row("Remote app").disabled).toBe(true);
    expect(row("Remote app").textContent).toContain("remote.status.connecting");
  });

  it("shows a list failure with retry", async () => {
    const { switcher } = createSwitcher(
      Promise.reject(new Error("relay timeout")),
      Promise.resolve({ workspaces: [local] }),
    );
    render(createElement(Sidebar, props(switcher)));

    expect((await screen.findByRole("alert")).textContent).toContain("relay timeout");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await screen.findByText("Local app");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the empty state when the desktop window has no workspace", async () => {
    const { switcher } = createSwitcher(Promise.resolve({ workspaces: [] }));
    render(createElement(Sidebar, props(switcher)));

    await screen.findByText("webRemoteControl.noSwitchableWorkspaces");
  });

  it("reports a failed reconnect and keeps the row available", async () => {
    const { switcher } = createSwitcher(Promise.resolve({ workspaces: [offline] }));
    switcher.reconnectWorkspace.mockRejectedValueOnce(new Error("ssh refused"));
    render(createElement(Sidebar, props(switcher)));

    fireEvent.click(await screen.findByText("Remote app"));
    // 失败沿用远程连接错误分类，提示本地化文案；原始错误只进日志。
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledWith("remote.error.unknown"));
    await waitFor(() => expect(row("Remote app").disabled).toBe(false));
    expect(switcher.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("keeps the project tree and does not request the relay list when project service exists", async () => {
    fixture.hasProjectService = true;
    const { switcher } = createSwitcher();
    render(createElement(Sidebar, props(switcher)));

    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());
    expect(screen.queryByText("webRemoteControl.homeOnlyWorkspaces")).toBeNull();
    expect(switcher.listWorkspaces).not.toHaveBeenCalled();
  });
});
