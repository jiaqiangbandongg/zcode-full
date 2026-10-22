// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { StorageCleanConfirmDialog } from "@/resource-manager/storage/StorageCleanConfirmDialog.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

afterEach(() => {
  cleanup();
  useConfirmDialogStore.getState().settleConfirmation(false);
});

describe("破坏性确认键盘防护", () => {
  it.each([undefined, "automation-confirmation"] as const)(
    "%s 默认聚焦取消，回车不能确认，显式点击才确认",
    async (presentation) => {
      render(createElement(ConfirmDialogHost));
      let result!: Promise<boolean>;
      act(() => {
        result = useConfirmDialogStore.getState().requestConfirmation({
          title: "删除",
          description: "删除操作不可恢复",
          presentation,
          confirmVariant: "destructive",
          confirmLabel: "删除",
          cancelLabel: "取消",
        });
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /取消/ }));
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      await expect(result).resolves.toBe(true);
    },
  );

  it.each(["plugin", "storage"] as const)("%s 独立破坏性弹窗也默认聚焦取消", (kind) => {
    const confirm = vi.fn();
    render(
      kind === "plugin"
        ? createElement(PluginUninstallConfirmDialog, {
            open: true,
            pluginName: "test",
            pending: false,
            onCancel: vi.fn(),
            onConfirm: confirm,
          })
        : createElement(StorageCleanConfirmDialog, {
            target: { categoryId: "logs", bytes: 1024 },
            pending: false,
            onCancel: vi.fn(),
            onConfirm: confirm,
          }),
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("普通确认保留回车快捷键", async () => {
    render(createElement(ConfirmDialogHost));
    let result!: Promise<boolean>;
    act(() => {
      result = useConfirmDialogStore
        .getState()
        .requestConfirmation({ title: "连接", description: "连接设备" });
    });
    fireEvent.keyDown(window, { key: "Enter" });
    await expect(result).resolves.toBe(true);
  });
});
