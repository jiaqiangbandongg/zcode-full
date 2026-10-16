// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

function renderEntry(onOpenSettings?: (origin: string) => void) {
  return render(
    createElement(BrowserSiteSettingsEntry, {
      origin: "https://example.com",
      onOpenSettings,
    }),
  );
}

it("点击滑杆图标展开站点信息气泡，展示 origin 与权限设置入口", async () => {
  renderEntry();
  fireEvent.click(screen.getByTestId("browser-permission-trigger"));
  expect(await screen.findByTestId("browser-permission-popover")).toBeTruthy();
  expect(screen.getByTestId("browser-permission-origin").textContent).toBe("https://example.com");
  expect(screen.getByTestId("browser-permission-open-settings")).toBeTruthy();
});

it("点击权限设置后弹窗关闭再回调（否则 trigger 随 tab 隐藏时 portal 内容会塌到窗口左上角）", async () => {
  const onOpenSettings = vi.fn();
  renderEntry(onOpenSettings);
  fireEvent.click(screen.getByTestId("browser-permission-trigger"));
  expect(await screen.findByTestId("browser-permission-popover")).toBeTruthy();
  fireEvent.click(screen.getByTestId("browser-permission-open-settings"));
  expect(onOpenSettings).toHaveBeenCalledWith("https://example.com");
  await waitFor(() =>
    expect(screen.queryByTestId("browser-permission-popover")).toBeNull(),
  );
});

it("点击权限设置回调目标 origin；无回调时入口禁用", async () => {
  const onOpenSettings = vi.fn();
  renderEntry(onOpenSettings);
  fireEvent.click(screen.getByTestId("browser-permission-trigger"));
  fireEvent.click(await screen.findByTestId("browser-permission-open-settings"));
  expect(onOpenSettings).toHaveBeenCalledWith("https://example.com");

  cleanup();
  renderEntry(undefined);
  fireEvent.click(screen.getByTestId("browser-permission-trigger"));
  expect((await screen.findByTestId("browser-permission-open-settings")).disabled).toBe(true);
});
