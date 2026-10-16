import { afterEach, describe, expect, it, vi } from "vitest";
import { BarChart3, Blocks, Cable, Package, WandSparkles } from "lucide-react";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

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
  it("按设置页心智顺序展示 test 分区", async () => {
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
        sections: ["general", "appearance", "modelProvider", "browser", "shortcuts"],
      },
      {
        id: "agentCapabilities",
        sections: ["memory", "subagents", "plugin", "mcp", "skill", "commands", "hooks"],
      },
      {
        id: "dataAndStats",
        sections: ["usage"],
      },
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
      "shortcuts",
      "usage",
    ]);
  });

  it("按设置页心智顺序展示 production 分区并保留 usage", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("production");
    const { settingsSections } = createSettingsPageConfig({});

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
      "shortcuts",
      "usage",
    ]);
  });

  it("Plugins 内容标题不再配置 beta 徽标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const pluginsSection = SETTINGS_SECTIONS.find((section) => section.id === "plugin");

    expect(pluginsSection?.titleBadgeId).toBeUndefined();
  });

  it("Models 与 Plugins 菜单使用统一资源图标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "modelProvider")?.icon).toBe(Package);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "plugin")?.icon).toBe(Blocks);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "mcp")?.icon).toBe(Cable);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "skill")?.icon).toBe(WandSparkles);
  });

  it("Usage 分区文案和头像菜单使用统计入口保持一致", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const usageSection = SETTINGS_SECTIONS.find((section) => section.id === "usage");

    expect(usageSection?.icon).toBe(BarChart3);
    expect(enUS["settings.usageTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(enUS["settings.usage.sectionTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(zhCN["settings.usageTitle"]).toBe(zhCN["sidebar.usage.plan.openStats"]);
  });

  it("侧栏分组标题同时提供中英文文案", () => {
    expect(enUS["settings.sidebar.group.basics"]).toBe("Basics");
    expect(enUS["settings.sidebar.group.agentCapabilities"]).toBe("Agent capabilities");
    expect(enUS["settings.sidebar.group.dataAndStats"]).toBe("Data and statistics");
    expect(zhCN["settings.sidebar.group.basics"]).toBe("基础设置");
    expect(zhCN["settings.sidebar.group.agentCapabilities"]).toBe("Agent 能力");
    expect(zhCN["settings.sidebar.group.dataAndStats"]).toBe("数据与统计");
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
