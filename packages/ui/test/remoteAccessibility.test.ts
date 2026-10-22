// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

afterEach(cleanup);

it.each([
  ["zh-CN", "关闭"],
  ["en-US", "Close"],
] as const)("%s 对话框关闭按钮有本地化名称", (locale, close) => {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        Dialog,
        { open: true },
        createElement(
          DialogContent,
          { "aria-describedby": undefined },
          createElement(DialogTitle, null, "Connection"),
        ),
      ),
    ),
  );
  expect(screen.getByRole("button", { name: close })).toBeTruthy();
});

it("状态变化在 live region 中读出，导航状态点有语义和名称", () => {
  const view = (state: "online" | "offline") =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(RemoteConnectionStatusTag, { status: state }),
      createElement(RemoteConnectionNavigationDot, {
        presentation: resolveRemoteConnectionPresentation({ state }),
      }),
    );
  const { rerender } = render(view("online"));
  expect(screen.getByRole("status").textContent).toContain("已连接");
  expect(screen.getByRole("img", { name: "已连接" })).toBeTruthy();
  rerender(view("offline"));
  expect(screen.getByRole("status").textContent).toContain("未连接");
  expect(screen.getByRole("img", { name: "未连接" })).toBeTruthy();
});
