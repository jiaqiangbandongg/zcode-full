// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteProjectDetailsPopover } from "@/WorkspaceSidebar/RemoteProjectDetailsPopover.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("悬停 400ms 打开可操作详情，点击立即打开，关闭菜单不残留详情", () => {
  vi.useFakeTimers();
  const anchorRef = createRef<HTMLDivElement>();
  const props = {
    anchorRef,
    tab: { id: "dev", kind: "workspace" as const, label: "project", workspacePath: "/srv/project" },
    deviceName: "Dev",
    presentation: resolveRemoteConnectionPresentation({ state: "offline" }),
    onConnect: vi.fn(),
  };
  const { rerender } = render(createElement(RemoteProjectDetailsPopover, props));
  const label = screen.getByRole("button", { name: "workspaceSidebar.connectionDetails" });
  expect(document.getElementById(label.getAttribute("aria-describedby")!)?.textContent).toBe("remote.status.offline");
  fireEvent.pointerEnter(label, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(399));
  expect(screen.queryByText("/srv/project")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("/srv/project")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  act(() => vi.runOnlyPendingTimers());
  expect(screen.queryByText("/srv/project")).toBeNull();
  fireEvent.click(label);
  expect(screen.getByText("/srv/project")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "remote.action.connect" }));
  expect(props.onConnect).toHaveBeenCalledOnce();
  fireEvent.click(label);
  rerender(createElement(RemoteProjectDetailsPopover, { ...props, disabled: true }));
  rerender(createElement(RemoteProjectDetailsPopover, props));
  act(() => vi.runOnlyPendingTimers());
  expect(screen.queryByText("/srv/project")).toBeNull();
});

it.each(["trigger", "content"])("悬停详情被键盘接管后不受鼠标离开计时器影响：%s", (target) => {
  vi.useFakeTimers();
  render(
    createElement(RemoteProjectDetailsPopover, {
      anchorRef: createRef<HTMLDivElement>(),
      tab: { id: "dev", kind: "workspace", label: "project", workspacePath: "/srv" },
      deviceName: "Dev",
      presentation: resolveRemoteConnectionPresentation({ state: "offline" }),
      onConnect: vi.fn(),
    }),
  );
  const trigger = screen.getByRole("button", { name: "workspaceSidebar.connectionDetails" });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(400));
  fireEvent.pointerLeave(trigger);
  if (target === "trigger") fireEvent.click(trigger);
  else act(() => screen.getByRole("button", { name: "remote.action.connect" }).focus());
  act(() => vi.advanceTimersByTime(150));
  expect(screen.getByText("/srv")).toBeTruthy();
});
