import { describe, expect, it } from "vitest";
import type {
  SkillSummary,
  ZCodeCommand,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  filterPluginsByQuery,
  groupScopedSkillsBySource,
  needsMcpAttention,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
  selectSkillsForScope,
  selectCommandsForScope,
} from "../src/settings/pluginCapabilityProjection.js";

const plugins = [
  {
    id: "lovable@market",
    name: "lovable",
    enabled: true,
    enabledSource: "user",
  },
  {
    id: "docs@market",
    name: "docs",
    enabled: false,
    enabledSource: "workspace",
  },
  {
    id: "browser@official",
    name: "browser",
    enabled: true,
    source: "official",
  },
] as ZCodePluginInfo[];
const installations = [
  { id: "lovable@market", scope: "user" },
  { id: "docs@market", scope: "workspace" },
] as ZCodeInstalledPluginSummary[];
const skills = [
  { id: "user", name: "user-skill", scope: "user", path: "/u" },
  { id: "workspace", name: "workspace-skill", scope: "workspace", path: "/w" },
  {
    id: "lovable",
    name: "lovable-skill",
    scope: "plugin",
    pluginName: "Lovable",
    path: "/l",
  },
  {
    id: "docs",
    name: "docs-skill",
    scope: "plugin",
    pluginName: "docs",
    path: "/d",
  },
  {
    id: "browser",
    name: "browser-skill",
    scope: "plugin",
    pluginName: "browser",
    path: "/b",
  },
] as SkillSummary[];

// Bug 根因：能力投影会先过滤 disabled Plugin；同名来源 fixture 必须携带协议必填的
// enabled=true，否则类型强转会把缺失字段伪装成合法数据并错误测试成空投影。
const sameNamePlugins = [
  {
    id: "computer-use@zcode-plugins-official",
    name: "computer-use",
    enabled: true,
    source: "official",
  },
  {
    id: "zcode-cua@custom-marketplace",
    name: "zcode-cua",
    enabled: true,
    source: "marketplace",
  },
] as ZCodePluginInfo[];

describe("Plugin capability projection", () => {
  it("keeps missing package projections out of Settings groups", () => {
    const missing = {
      id: "missing@market",
      name: "missing",
      enabled: true,
      source: "missing",
      packageStatus: "missing",
    } as ZCodePluginInfo;
    const installed = {
      id: "installed@market",
      name: "installed",
      enabled: true,
      source: "marketplace",
    } as ZCodePluginInfo;
    const builtIn = {
      id: "builtin@official",
      name: "builtin",
      enabled: true,
      source: "official",
    } as ZCodePluginInfo;

    expect(
      partitionPluginsForSettings([missing, installed, builtIn], new Set([builtIn.id])),
    ).toEqual({
      installed: [installed],
      builtIn: [builtIn],
    });
  });

  it("puts only MCP resources requiring authorization into Needs Attention", () => {
    expect(
      needsMcpAttention({
        authorization: { authorizationUrl: "https://auth.example" },
      }),
    ).toBe(true);
    expect(needsMcpAttention({ authorization: {} })).toBe(false);
    expect(needsMcpAttention({})).toBe(false);
  });

  it("filters plugins by name and marketplace", () => {
    const searchablePlugins = [
      { id: "lovable", name: "Lovable", marketplace: "OpenAI" },
      { id: "docs", name: "Docs Canvas", marketplace: "Cursor" },
    ] as ZCodePluginInfo[];
    expect(filterPluginsByQuery(searchablePlugins, "LOVA")).toEqual([searchablePlugins[0]]);
    expect(filterPluginsByQuery(searchablePlugins, "cUrSoR")).toEqual([searchablePlugins[1]]);
  });

  it("shows the complete scope-specific projection returned by the Agent", () => {
    expect(selectPluginsForScope(plugins, installations, "user").map((item) => item.name)).toEqual([
      "lovable",
      "docs",
      "browser",
    ]);
    expect(
      selectPluginsForScope(plugins, installations, "workspace").map((item) => item.name),
    ).toEqual(["lovable", "docs", "browser"]);
  });

  it("does not use legacy installation scope as configuration-view ownership", () => {
    const legacyPlugin = {
      id: "legacy@market",
      name: "legacy",
      enabled: true,
      enabledSource: "user",
    } as ZCodePluginInfo;
    const legacyInstallation = {
      id: legacyPlugin.id,
      scope: "workspace",
    } as ZCodeInstalledPluginSummary;

    expect(selectPluginsForScope([legacyPlugin], [legacyInstallation], "user")).toEqual([
      legacyPlugin,
    ]);
    expect(selectPluginsForScope([legacyPlugin], [legacyInstallation], "workspace")).toEqual([
      legacyPlugin,
    ]);
  });

  it("keeps inherited User and Workspace override rows together in Workspace view", () => {
    const scopedPlugins = [
      {
        id: "workspace-root@inline",
        name: "workspace-root",
        enabled: true,
        rootSource: "workspace",
      },
      {
        id: "workspace-option@market",
        name: "workspace-option",
        enabled: true,
        optionSources: { token: "workspace" },
      },
      {
        id: "inherited-user@market",
        name: "inherited-user",
        enabled: true,
        enabledSource: "user",
      },
    ] as unknown as ZCodePluginInfo[];

    expect(selectPluginsForScope(scopedPlugins, [], "workspace").map((item) => item.name)).toEqual([
      "workspace-root",
      "workspace-option",
      "inherited-user",
    ]);
  });

  it("keeps built-ins in user scope but outside installed groups", () => {
    expect(selectBuiltInPlugins(plugins, installations).map((item) => item.name)).toEqual([
      "browser",
    ]);
  });

  it("lets an explicit installation override official-source built-in classification", () => {
    const officialInstallation = {
      id: "browser@official",
      scope: "workspace",
    } as ZCodeInstalledPluginSummary;
    const installed = [...installations, officialInstallation];

    expect(selectBuiltInPlugins(plugins, installed)).toEqual([]);
    expect(selectPluginsForScope(plugins, installed, "workspace").map((item) => item.name)).toEqual(
      ["lovable", "docs", "browser"],
    );
    expect(selectPluginsForScope(plugins, installed, "user").map((item) => item.name)).toEqual([
      "lovable",
      "docs",
      "browser",
    ]);
  });

  it("keeps direct and plugin-contributed skills inside the selected scope", () => {
    const userPlugins = selectPluginsForScope(plugins, installations, "user");
    expect(selectSkillsForScope(skills, userPlugins, "user").map((item) => item.name)).toEqual([
      "user-skill",
      "lovable-skill",
      "browser-skill",
    ]);
  });

  it("groups skills by direct source and concrete plugin name", () => {
    const groups = groupScopedSkillsBySource(selectSkillsForScope(skills, plugins, "user"), "User");
    expect(groups.map((group) => [group.label, group.skills.length])).toEqual([
      ["User", 1],
      ["browser", 1],
      ["Lovable", 1],
    ]);
  });

  it("keeps direct and plugin-contributed commands inside the selected scope", () => {
    const commands = [
      { id: "user", source: "user", location: { scope: "user" } },
      { id: "workspace", source: "user", location: { scope: "project" } },
      { id: "lovable", source: "plugin", pluginName: "Lovable" },
      { id: "docs", source: "plugin", pluginName: "docs" },
    ] as ZCodeCommand[];

    expect(
      selectCommandsForScope(
        commands,
        selectPluginsForScope(plugins, installations, "workspace"),
        "workspace",
      ).map((command) => command.id),
    ).toEqual(["workspace", "lovable"]);
  });

  it("hides capabilities contributed by disabled plugins", () => {
    expect(selectSkillsForScope(skills, plugins, "workspace").map((item) => item.name)).toEqual([
      "workspace-skill",
      "lovable-skill",
      "browser-skill",
    ]);
  });

  it("keeps same-name plugin skills tied to their full plugin id", () => {
    const sameNameSkills = [
      {
        id: "official-skill",
        name: "official-skill",
        scope: "plugin",
        pluginName: "computer-use",
        pluginId: "computer-use@zcode-plugins-official",
        path: "/official",
      },
      {
        id: "custom-skill",
        name: "custom-skill",
        scope: "plugin",
        pluginName: "zcode-cua",
        pluginId: "zcode-cua@custom-marketplace",
        path: "/custom",
      },
    ] as SkillSummary[];

    const selected = selectSkillsForScope(sameNameSkills, sameNamePlugins, "user");
    const groups = groupScopedSkillsBySource(selected, "User");

    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ["plugin:computer-use@zcode-plugins-official", "computer-use"],
      ["plugin:zcode-cua@custom-marketplace", "zcode-cua"],
    ]);
    expect(groups.map((group) => group.skills[0]?.id)).toEqual(["official-skill", "custom-skill"]);
  });

  it("does not select a same-name plugin command from another marketplace", () => {
    const commands = [
      {
        id: "official-command",
        source: "plugin",
        pluginName: "computer-use",
        pluginMarketplace: "zcode-plugins-official",
      },
      {
        id: "custom-command",
        source: "plugin",
        pluginName: "zcode-cua",
        pluginMarketplace: "custom-marketplace",
      },
    ] as ZCodeCommand[];

    expect(
      selectCommandsForScope(commands, [sameNamePlugins[0]!], "user").map((command) => command.id),
    ).toEqual(["official-command"]);
  });
});

describe("localized managed plugin search", () => {
  const plugin = {
    id: "lark-cli@official",
    name: "lark-cli",
    marketplace: "official",
    description: "English description",
  } as ZCodePluginInfo;
  const item = {
    id: plugin.id,
    name: plugin.name,
    marketplace: plugin.marketplace,
    installed: true,
    orphaned: false,
    restorable: false,
    info: plugin,
    listing: {
      displayName: "Lark CLI",
      displayNameI18n: { "zh-CN": "飞书 CLI" },
      descriptionI18n: { "zh-CN": "文档协作" },
    },
  };
  it("matches the displayed localized name and description as well as stable identity", () => {
    const items = new Map([[plugin.id, item]]);
    for (const query of ["飞书", "文档协作", "LARK-CLI", "lark-cli@official"]) {
      expect(filterPluginsByQuery([plugin], query, items, "zh-CN")).toEqual([plugin]);
    }
    expect(filterPluginsByQuery([plugin], "文档协作", items, "en-US")).toEqual([]);
  });
  it("does not borrow listing from a same-name plugin in another marketplace", () => {
    const other = { ...plugin, id: "lark-cli@other", marketplace: "other" };
    expect(filterPluginsByQuery([other], "飞书", new Map([[plugin.id, item]]), "zh-CN")).toEqual(
      [],
    );
    expect(filterPluginsByQuery([other], "English description", new Map(), "zh-CN")).toEqual([
      other,
    ]);
  });
});

it("puts official PDF, PPT, Excel and Word first in the preset group", () => {
  const names = ["aaa", "documents", "spreadsheets", "presentations", "pdf"];
  const plugins = names.map(
    (name) =>
      ({
        id: `${name}@zcode-plugins-official`,
        name,
        source: "official",
        enabled: false,
      }) as ZCodePluginInfo,
  );
  const groups = partitionPluginsForSettings(plugins, new Set(plugins.map((plugin) => plugin.id)));
  expect(groups.builtIn.map((plugin) => plugin.name)).toEqual([
    "pdf",
    "presentations",
    "spreadsheets",
    "documents",
    "aaa",
  ]);
  expect(plugins[0]?.name).toBe("aaa");
});
