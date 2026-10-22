import { afterEach, describe, expect, it, vi } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { isSettingsSectionAvailable } from "../src/settings/settingsPageConfig.js";

async function loadSettingsPageConfig(env: "test" | "production") {
  vi.resetModules();
  vi.doMock("@zcode/shared", async () => {
    const actual = await vi.importActual<typeof import("@zcode/shared")>("@zcode/shared");
    return {
      ...actual,
      ZCODE_ENV: env,
    };
  });
  return import("../src/settings/settingsPageConfig.js");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("settingsPageConfig", () => {
  it("only exposes remote device management on desktop", () => {
    expect(isSettingsSectionAvailable("remoteDevices", true)).toBe(true);
    expect(isSettingsSectionAvailable("remoteDevices", false)).toBe(false);
    expect(isSettingsSectionAvailable("general", false)).toBe(true);
  });
  it("按设置页分组与顺序展示公开分区", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups, settingsSections } = createSettingsPageConfig({});
    expect(
      settingsSectionGroups.map((group) => ({
        id: group.id,
        sections: group.sections.map((section) => section.id),
      })),
    ).toEqual([
      {
        id: "basics",
        sections: [
          "general",
          "appearance",
          "modelProvider",
          "browser",
          "remoteDevices",
          "shortcuts",
        ],
      },
      {
        id: "agentCapabilities",
        sections: ["memory", "subagents", "plugin", "mcp", "skill", "commands", "hooks"],
      },
      { id: "dataAndStats", sections: ["gitBackup", "usage", "archives"] },
    ]);
    expect(settingsSections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "memory",
      "subagents",
      "plugin",
      "mcp",
      "skill",
      "commands",
      "hooks",
      "browser",
      "remoteDevices",
      "shortcuts",
      "gitBackup",
      "usage",
      "archives",
    ]);
  });

  it("Usage 分区文案和头像菜单使用统计入口保持一致", () => {
    expect(enUS["settings.usageTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(enUS["settings.usage.sectionTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(zhCN["settings.usageTitle"]).toBe(zhCN["sidebar.usage.plan.openStats"]);
  });

  it.each([
    ["macOS", { isMacDesktop: true }, true],
    ["Windows", { isWindowsDesktop: true }, true],
    ["Linux 桌面", { isDesktop: true }, true],
    ["Web", {}, false],
  ] as const)("%s 的电脑控制入口符合桌面平台边界", async (_name, options, expected) => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig(options);

    expect(settingsSections.some((section) => section.id === "computerUse")).toBe(expected);
  });

  it("桌面平台的电脑控制排在基础设置的浏览器之后", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups } = createSettingsPageConfig({ isMacDesktop: true });
    const basics = settingsSectionGroups.find((group) => group.id === "basics");

    expect(basics?.sections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "browser",
      "remoteDevices",
      "computerUse",
      "shortcuts",
    ]);
    expect(
      settingsSectionGroups
        .find((group) => group.id === "agentCapabilities")
        ?.sections.some((section) => section.id === "computerUse"),
    ).toBe(false);
  });

  it("不可见的电脑控制落点回退到 general", async () => {
    const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
      await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig({});

    expect(resolveSettingsSectionForPlatform("computerUse", settingsSections, "general")).toBe(
      "general",
    );
  });
});
