// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  error: vi.fn(),
  settings: { shortcutBindings: { toggleSidebar: ["CmdOrCtrl+e"] } },
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings, update: mocks.update }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({}) }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({ logger: { error: mocks.error } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  vi.clearAllMocks();
});
async function mount(isDesktop = true) {
  container = document.createElement("div");
  root = createRoot(container);
  await act(() => root.render(createElement(ShortcutSettingsSection, { isDesktop })));
}
function button(id: string) {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
}
describe("shortcut settings save admission", () => {
  it("blocks edits until the settings update finishes, then admits the next edit", async () => {
    let finish!: () => void;
    mocks.update
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    await mount();
    expect(button("settings-shortcut-reset-all").disabled).toBe(false);
    await act(() => button("settings-shortcut-clear-toggleSidebar").click());
    expect(button("settings-shortcut-edit-openCommandCenter-0").disabled).toBe(true);
    expect(button("settings-shortcut-clear-openCommandCenter").disabled).toBe(true);
    expect(button("settings-shortcut-reset-all").disabled).toBe(true);
    await act(() => button("settings-shortcut-clear-openCommandCenter").click());
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(button("settings-shortcut-edit-openCommandCenter-0").disabled).toBe(false);
    await act(() => button("settings-shortcut-clear-openCommandCenter").click());
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
  it("shows a save failure, preserves settings and permits a user retry", async () => {
    mocks.update.mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
    await mount();
    await act(() => button("settings-shortcut-clear-toggleSidebar").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "settings.shortcuts.saveFailed",
    );
    expect(button("settings-shortcut-bind-toggleSidebar-0")).toBeTruthy();
    expect(button("settings-shortcut-clear-toggleSidebar").disabled).toBe(false);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    await act(() => button("settings-shortcut-clear-toggleSidebar").click());
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  // 完整视图只在桌面端提供（docs/ui/side-pane-full-view.md），Web 设置页不展示该命令。
  it("lists the side pane full view shortcut only on desktop", async () => {
    await mount(true);
    expect(button("settings-shortcut-clear-toggleSidePaneFullView")).toBeTruthy();
    await act(() => root.unmount());
    await mount(false);
    expect(
      container.querySelector('[data-testid="settings-shortcut-clear-toggleSidePaneFullView"]'),
    ).toBeNull();
  });
});
