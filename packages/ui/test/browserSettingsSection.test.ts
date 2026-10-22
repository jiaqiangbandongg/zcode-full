// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const importChromeBrowserData = vi.fn(async () => ({
    success: true,
    cookies: { imported: 3, skipped: 1, failed: 0 },
    localStorage: {
      originsImported: 1,
      entriesImported: 2,
      originsSkipped: 0,
      originsFailed: 0,
    },
  }));
  const clearEmbeddedBrowserData = vi.fn(async () => ({ success: true }));
  const initialize = vi.fn(async () => {});
  const setEnabled = vi.fn(async (_pluginId: string, enabled: boolean) => {
    pluginState.plugins[0].enabled = enabled;
  });
  const pluginState = {
    plugins: [
      {
        id: "browser-use@zcode-plugins-official",
        name: "browser-use",
        enabled: true,
      },
    ],
    loading: false,
    error: null as string | null,
    togglingPluginId: null as string | null,
    initialize,
    setEnabled,
  };
  return {
    clearEmbeddedBrowserData,
    importChromeBrowserData,
    initialize,
    pluginState,
    setEnabled,
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    importChromeBrowserData: h.importChromeBrowserData,
    clearEmbeddedBrowserData: h.clearEmbeddedBrowserData,
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    pluginManagementService: {},
    skillsService: {},
  }),
}));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({}),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: vi.fn(async () => {}),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: Object.assign(
    (selector: (state: typeof h.pluginState) => unknown) => selector(h.pluginState),
    { getState: () => h.pluginState },
  ),
}));
vi.mock("@/store/skillStore.js", () => ({
  useSkillStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      refresh: vi.fn(async () => {}),
      workspacePath: null,
      workspaceIdentity: null,
    }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.pluginState.plugins[0].enabled = true;
  h.pluginState.loading = false;
  h.pluginState.error = null;
  h.pluginState.togglingPluginId = null;
});

function renderSection(
  isDesktop = true,
  isWindowsDesktop = false,
  overrides: Record<string, unknown> = {},
) {
  return render(
    createElement(BrowserSettingsSection, {
      isDesktop,
      isWindowsDesktop,
      workspacePath: "/workspace",
      workspaceIdentity: "workspace-id",
      ...overrides,
    }),
  );
}

describe("BrowserSettingsSection", () => {
  it("展示忽略证书校验开关，默认关闭并把用户选择回传保存", () => {
    const onChange = vi.fn(async () => {});
    renderSection(true, false, {
      embeddedBrowserAllowInsecureCertificates: false,
      onEmbeddedBrowserAllowInsecureCertificatesChange: onChange,
    });

    const toggle = screen.getByRole("switch", {
      name: "settings.embeddedBrowserAllowInsecureCertificates",
    });
    // 降低安全性的开关必须默认关闭，用户升级新版本不能被动获得放行行为。
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("开关已开启时反映选中态", () => {
    renderSection(true, false, {
      embeddedBrowserAllowInsecureCertificates: true,
      onEmbeddedBrowserAllowInsecureCertificatesChange: vi.fn(async () => {}),
    });

    expect(
      screen
        .getByRole("switch", { name: "settings.embeddedBrowserAllowInsecureCertificates" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("非桌面端不展示忽略证书校验开关", () => {
    renderSection(false, false, {
      embeddedBrowserAllowInsecureCertificates: false,
      onEmbeddedBrowserAllowInsecureCertificatesChange: vi.fn(async () => {}),
    });

    expect(
      screen.queryByRole("switch", {
        name: "settings.embeddedBrowserAllowInsecureCertificates",
      }),
    ).toBeNull();
  });

  it("复用官方 browser-use plugin 开关并初始化当前 workspace", async () => {
    renderSection();

    expect(h.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/workspace",
        workspaceIdentity: "workspace-id",
      }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "settings.browser.control.title" }));

    await waitFor(() => {
      expect(h.setEnabled).toHaveBeenCalledWith(
        "browser-use@zcode-plugins-official",
        false,
        expect.anything(),
      );
    });
  });

  it("桌面端一键导入 Chrome 当前 Profile 的 Cookie 与 LocalStorage", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "settings.browser.import.action" }));

    await waitFor(() => {
      expect(h.importChromeBrowserData).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText("settings.browser.import.success")).toBeTruthy();
  });

  it("Windows 暂时隐藏导入入口但保留浏览器数据清理", () => {
    renderSection(true, true);

    expect(screen.queryByRole("button", { name: "settings.browser.import.action" })).toBeNull();
    expect(screen.getByRole("button", { name: "settings.browser.clearCache.action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "settings.browser.clearAll.action" })).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: "settings.browser.import.adminConsent" }),
    ).toBeNull();
    expect(h.importChromeBrowserData).not.toHaveBeenCalled();
  });

  it("未安装 Chrome 时展示 Chrome 未找到提示", async () => {
    h.importChromeBrowserData.mockResolvedValueOnce({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "chrome_executable_not_found",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "settings.browser.import.action" }));

    expect(await screen.findByText("settings.browser.import.executableNotFound")).toBeTruthy();
  });

  it("Profile 无法自动消歧时展示可操作错误", async () => {
    h.importChromeBrowserData.mockResolvedValueOnce({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "chrome_profile_ambiguous",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "settings.browser.import.action" }));

    expect(await screen.findByText("settings.browser.import.ambiguous")).toBeTruthy();
  });

  it("macOS 钥匙串授权被拒绝时提示导入已取消", async () => {
    h.importChromeBrowserData.mockResolvedValueOnce({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "chrome_cookie_access_denied",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "settings.browser.import.action" }));

    expect(await screen.findByText("settings.browser.import.accessDenied")).toBeTruthy();
  });

  it("部分 Cookie 未导入时只展示实际导入数量", async () => {
    h.importChromeBrowserData.mockResolvedValueOnce({
      success: true,
      cookies: { imported: 2, skipped: 4, failed: 0 },
      localStorage: {
        originsImported: 1,
        entriesImported: 3,
        originsSkipped: 0,
        originsFailed: 0,
      },
      issues: ["chrome_cookie_protection_unsupported"],
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "settings.browser.import.action" }));

    expect(await screen.findByText("settings.browser.import.success")).toBeTruthy();
    expect(screen.queryByText("settings.browser.import.partialCookieProtected")).toBeNull();
    expect(screen.queryByText("settings.browser.import.successWithSkipped")).toBeNull();
  });

  it("Web/手机端禁用本机浏览器数据操作并展示桌面端提示", () => {
    renderSection(false);

    expect(screen.getByText("settings.browser.desktopOnly")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "settings.browser.import.action",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "settings.browser.clearCache.action",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
