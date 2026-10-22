// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { WebRemoteControlTaskViewReporter } from "@/web-remote-control/WebRemoteControlTaskViewReporter.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/WebRemoteControlThemeMenu.js", () => ({ WebRemoteControlThemeMenu: () => null }));

const workspacePath = "/repo";
const workspaceIdentity = "remote:server:source:/repo";
let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  useZCodeSessionStore.setState({ workspaces: {}, taskNavHistory: { entries: [], cursor: -1 } });
  window.history.replaceState({}, "");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture(activeTaskId: string | null = "task") {
  if (activeTaskId)
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, activeTaskId, workspaceIdentity);
  const updateMobileTaskView = vi.fn<
    NonNullable<WebRemoteControlWorkspaceSwitcherApi["updateMobileTaskView"]>
  >(async () => {});
  const updateMobileViewState = vi.fn<
    NonNullable<WebRemoteControlWorkspaceSwitcherApi["updateMobileViewState"]>
  >(async () => {});
  const props = {
    enabled: true,
    activeTaskId,
    workspacePath,
    workspaceIdentity,
    switcher: { updateMobileTaskView, updateMobileViewState },
  };
  const ui = render(createElement(WebRemoteControlTaskViewReporter, props));
  return { ...ui, props, updateMobileTaskView, updateMobileViewState };
}

it("reports draft promotion once from the committed full address and updates navigation in either viewport", () => {
  const f = fixture(null);
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
  act(() =>
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task", workspaceIdentity),
  );
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, activeTaskId: "task" }));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
  expect(f.updateMobileViewState).toHaveBeenLastCalledWith(workspaceIdentity, "task");
  const count = f.updateMobileTaskView.mock.calls.length;
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, activeTaskId: "task" }));
  expect(f.updateMobileTaskView).toHaveBeenCalledTimes(count);
  f.unmount();
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
});

it("clears a disabled task view once and restores it when enabled", () => {
  const f = fixture();
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, enabled: false }));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
  const count = f.updateMobileTaskView.mock.calls.length;
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, enabled: false }));
  expect(f.updateMobileTaskView).toHaveBeenCalledTimes(count);
  f.rerender(createElement(WebRemoteControlTaskViewReporter, f.props));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
});

it("clears on page background/lifecycle and restores only while visible", () => {
  const f = fixture();
  act(() => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
  const count = f.updateMobileTaskView.mock.calls.length;
  act(() => window.dispatchEvent(new Event("pageshow")));
  expect(f.updateMobileTaskView).toHaveBeenCalledTimes(count);
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
});

it("does not infer viewing from a cached task before its complete navigation is committed", () => {
  const f = fixture("cached");
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, enabled: false }));
  act(() =>
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "target", workspaceIdentity),
  );
  // 切换屏障结束前缓存 task 仍可能作为旧 props 存在，不能上报它已被查看。
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, enabled: true }));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
  f.rerender(
    createElement(WebRemoteControlTaskViewReporter, { ...f.props, activeTaskId: "target" }),
  );
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "target",
    workspacePath,
    workspaceIdentity,
  });
});

it("does not turn a callback reference change into a new viewing event", () => {
  const f = fixture();
  const updateMobileTaskView = vi.fn<
    NonNullable<WebRemoteControlWorkspaceSwitcherApi["updateMobileTaskView"]>
  >(async () => {});
  f.rerender(
    createElement(WebRemoteControlTaskViewReporter, {
      ...f.props,
      switcher: { ...f.props.switcher, updateMobileTaskView },
    }),
  );
  expect(f.updateMobileTaskView).toHaveBeenCalledTimes(1);
  expect(updateMobileTaskView).not.toHaveBeenCalled();
  act(() => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
});

it("uses the mobile shell's real Home, Root visibility and inert overlay gates", () => {
  useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task", workspaceIdentity);
  const updateMobileTaskView = vi.fn<
    NonNullable<WebRemoteControlWorkspaceSwitcherApi["updateMobileTaskView"]>
  >(async () => {});
  const props = {
    activeTaskId: "task",
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    taskViewEnabled: true,
    chatContent: createElement("main", { "data-testid": "task-content" }),
    renderChatHeader: () => null,
    renderTaskHome: ({ navigateToChat }: { navigateToChat(): void }) =>
      createElement("button", { onClick: navigateToChat, "data-testid": "enter-chat" }, "Enter"),
    switcher: {
      listWorkspaces: async () => ({ workspaces: [] }),
      switchWorkspace: async () => {},
      updateMobileTaskView,
    },
  };
  const ui = render(createElement(WebRemoteControlMobileShell, props));
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
  act(() => ui.getByTestId("enter-chat").click());
  expect(updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
  ui.rerender(createElement(WebRemoteControlMobileShell, { ...props, taskViewEnabled: false }));
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
  ui.rerender(createElement(WebRemoteControlMobileShell, props));
  expect(updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
  ui.rerender(
    createElement(WebRemoteControlMobileShell, {
      ...props,
      sidePaneContent: createElement("aside"),
      isSidePaneOpen: true,
    }),
  );
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
  ui.rerender(createElement(WebRemoteControlMobileShell, props));
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: {} })));
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
});

it("MRO03：freeze 撤销查看，resume 只重读当前真正可见目标", () => {
  const f = fixture();
  act(() => document.dispatchEvent(new Event("freeze")));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
  const count = f.updateMobileTaskView.mock.calls.length;
  act(() => {
    visibility = "hidden";
    document.dispatchEvent(new Event("resume"));
  });
  expect(f.updateMobileTaskView).toHaveBeenCalledTimes(count);
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("resume"));
  });
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith({
    workspacePath,
    workspaceIdentity,
    taskId: "task",
  });
  act(() => document.dispatchEvent(new Event("freeze")));
  f.rerender(createElement(WebRemoteControlTaskViewReporter, { ...f.props, enabled: false }));
  act(() => document.dispatchEvent(new Event("resume")));
  expect(f.updateMobileTaskView).toHaveBeenLastCalledWith(null);
});

it("MRO03：连续聊天跨宽窄布局不撤销查看，真正返回 Home 才撤销", () => {
  useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task", workspaceIdentity);
  const updateMobileTaskView = vi.fn(async () => {});
  const props = {
    activeTaskId: "task",
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    initialNavigationIntent: "chat" as const,
    chatContent: createElement("main", { "data-testid": "narrow-chat" }),
    renderChatHeader: () => null,
    renderTaskHome: () => createElement("aside", { "data-testid": "task-home" }),
    switcher: {
      listWorkspaces: async () => ({ workspaces: [] }),
      switchWorkspace: async () => {},
      updateMobileTaskView,
    },
    children: createElement("main", { "data-testid": "wide-chat" }),
  };
  const ui = render(createElement(WebRemoteControlMobileShell, props));
  expect(ui.getByTestId("narrow-chat")).toBeTruthy();
  const firstView = updateMobileTaskView.mock.calls.slice();
  for (const isMobileViewport of [false, true, false, true]) {
    ui.rerender(createElement(WebRemoteControlMobileShell, { ...props, isMobileViewport }));
    expect(ui.getByTestId(isMobileViewport ? "narrow-chat" : "wide-chat")).toBeTruthy();
    expect(updateMobileTaskView.mock.calls).toEqual(firstView);
  }
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: {} })));
  expect(ui.getByTestId("task-home")).toBeTruthy();
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
  ui.rerender(createElement(WebRemoteControlMobileShell, { ...props, isMobileViewport: false }));
  expect(updateMobileTaskView).toHaveBeenLastCalledWith({
    taskId: "task",
    workspacePath,
    workspaceIdentity,
  });
  // 返回窄屏应保留用户选过的 Home，不能再次消费旧的初始 chat 意图。
  ui.rerender(createElement(WebRemoteControlMobileShell, { ...props, isMobileViewport: true }));
  expect(ui.getByTestId("task-home")).toBeTruthy();
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
  ui.unmount();
  expect(updateMobileTaskView).toHaveBeenLastCalledWith(null);
});
