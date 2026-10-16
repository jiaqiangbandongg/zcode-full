import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { createSettingsTestServices } from "./lib/settingsTestServices.js";

function renderNewTaskButtonGroup() {
  return renderToStaticMarkup(
    createElement(
      // 快捷键特性后组件经 useShortcutCommandLabel → useSettings 读 ServiceContext 与
      // PlatformContext，裸渲染需提供最小 ServiceProvider/PlatformProvider
      ServiceProvider,
      { services: createSettingsTestServices() },
      createElement(
        PlatformProvider,
        { platform: {} as unknown as IPlatformService },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TabStoreProvider,
            null,
            createElement(NewTaskButtonGroup, {
              onCreateTask: () => {},
            }),
          ),
        ),
      ),
    ),
  );
}

describe("NewTaskButtonGroup shortcut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("macOS 展示 ⌘ N", () => {
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    });

    const html = renderNewTaskButtonGroup();

    expect(html).toContain("⌘ N");
  });

  it("Windows/Linux 展示 Ctrl+N", () => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });

    const html = renderNewTaskButtonGroup();

    expect(html).toContain("Ctrl+N");
  });

  it("格式化工具会按平台返回正确的主修饰键", () => {
    expect(
      formatCommandShortcutLabel("n", {
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      }),
    ).toBe("⌘ N");
    expect(
      formatCommandShortcutLabel("n", {
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe("Ctrl+N");
  });
});
