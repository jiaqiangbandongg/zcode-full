import { describe, expect, it } from "vitest";
import type {
  SkillSummary,
  ZCodeCommand,
  ZCodeMcpServer,
  ZCodePluginComponentGroup,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  buildInstalledPluginDisplayGroups,
  buildPluginMcpServerItems,
  filterLocalMcpServers,
  groupCommandsByPlugin,
  groupPluginMcpServersByPlugin,
  groupSkillsByPlugin,
} from "@/settings/pluginManagedResourceGroups.js";

describe("pluginManagedResourceGroups", () => {
  it("groups MCP servers by stable plugin id and keeps attention rows first", () => {
    const groups = groupPluginMcpServersByPlugin([
      {
        active: true,
        id: "plugin-a:healthy",
        name: "healthy",
        pluginEnabled: true,
        pluginId: "plugin-a@market-a",
        pluginMarketplace: "market-a",
        pluginName: "same-name",
        runtimeServerName: "plugin:same-name:healthy",
        status: "connected",
      },
      {
        active: true,
        error: "failed",
        id: "plugin-a:failed",
        name: "failed",
        pluginEnabled: true,
        pluginId: "plugin-a@market-a",
        pluginMarketplace: "market-a",
        pluginName: "same-name",
        runtimeServerName: "plugin:same-name:failed",
        status: "error",
      },
      {
        active: true,
        id: "plugin-b:other",
        name: "other",
        pluginEnabled: true,
        pluginId: "plugin-b@market-b",
        pluginMarketplace: "market-b",
        pluginName: "same-name",
        runtimeServerName: "plugin:same-name:other",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.pluginId)).toEqual([
      "plugin-a@market-a",
      "plugin-b@market-b",
    ]);
    expect(groups[0]?.items.map((item) => item.name)).toEqual(["failed", "healthy"]);
  });
  it("groups skills by plugin scope", () => {
    const skills: SkillSummary[] = [
      {
        body: "",
        description: "local",
        enabled: true,
        id: "local",
        name: "local-review",
        path: "/workspace/.zcode/skills/local-review/SKILL.md",
        scope: "workspace",
      },
      {
        body: "",
        description: "plugin",
        enabled: true,
        id: "plugin",
        name: "ios-dev",
        path: "/home/.zcode/cli/plugins/cache/zcode-plugins-official/ios/0.1.0/skills/ios-dev/SKILL.md",
        pluginName: "ios-simulator",
        scope: "plugin",
      },
    ];

    const grouped = groupSkillsByPlugin(skills, "IOS");

    expect(grouped.local).toEqual([]);
    expect(grouped.plugin.map((skill) => skill.name)).toEqual(["ios-dev"]);
  });

  it("groups user and plugin commands separately", () => {
    const commands: ZCodeCommand[] = [
      {
        agentSource: "zcodeAgent",
        content: "local",
        description: "local command",
        enabled: true,
        filePath: "/home/.zcode/commands/review.md",
        id: "zcodeAgent:zcode:global:/review",
        location: {
          directoryPath: "/home/.zcode/commands",
          scope: "user",
          source: "zcode",
        },
        name: "/review",
        prompt: "local",
        scope: "global",
        source: "user",
      },
      {
        content: "plugin",
        description: "plugin command",
        enabled: true,
        filePath: "/home/.zcode/cli/plugins/cache/plugin/commands/ios-dev.md",
        id: "plugin:zcode-plugins-official:ios-simulator:/ios-dev",
        name: "/ios-dev",
        pluginEnabled: true,
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "ios-simulator",
        prompt: "plugin",
        scope: "global",
        source: "plugin",
      },
    ];

    const grouped = groupCommandsByPlugin(commands, "");

    expect(grouped.local.map((command) => command.name)).toEqual(["/review"]);
    expect(grouped.plugin.map((command) => command.pluginName)).toEqual(["ios-simulator"]);
  });

  it("builds plugin MCP items from enabled plugin metadata", () => {
    const servers: ZCodeMcpServer[] = [
      {
        config: { command: "npx", type: "stdio" },
        enabled: true,
        id: "zcodeagentmcp-global-memory",
        name: "memory",
        scope: "user",
        source: "zcodeagentmcp",
      },
      {
        config: { command: "npx", type: "stdio" },
        enabled: true,
        id: "codex-global-other",
        name: "other",
        scope: "user",
        source: "codexclimcp",
      },
    ];
    const plugins: ZCodePluginInfo[] = [
      {
        commandRootCount: 0,
        declaredMcpServerNames: ["ios-simulator", "ios-helper"],
        enabled: false,
        id: "ios-simulator@zcode-plugins-official",
        marketplace: "zcode-plugins-official",
        mcpServerNames: [],
        name: "ios-simulator",
        rootPath: "/plugins/ios-simulator",
        skillRootCount: 0,
        source: "official",
      },
    ];

    expect(filterLocalMcpServers(servers, "MEMORY").map((server) => server.name)).toEqual([
      "memory",
    ]);
    expect(buildPluginMcpServerItems(plugins, "IoS")).toEqual([
      {
        active: false,
        id: "ios-simulator@zcode-plugins-official:ios-simulator",
        name: "ios-simulator",
        pluginEnabled: false,
        pluginId: "ios-simulator@zcode-plugins-official",
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "ios-simulator",
        runtimeServerName: "plugin:ios-simulator:ios-simulator",
      },
      {
        active: false,
        id: "ios-simulator@zcode-plugins-official:ios-helper",
        name: "ios-helper",
        pluginEnabled: false,
        pluginId: "ios-simulator@zcode-plugins-official",
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "ios-simulator",
        runtimeServerName: "plugin:ios-simulator:ios-helper",
      },
    ]);
  });

  it("marks plugin MCP items active when runtime server names are namespaced", () => {
    const plugins: ZCodePluginInfo[] = [
      {
        commandRootCount: 0,
        declaredMcpServerNames: ["chrome-devtools"],
        enabled: true,
        id: "chrome-devtools-mcp@claude-plugins-official",
        marketplace: "claude-plugins-official",
        mcpServerNames: ["plugin:chrome-devtools-mcp:chrome-devtools"],
        name: "chrome-devtools-mcp",
        rootPath: "/plugins/chrome-devtools-mcp",
        skillRootCount: 0,
        source: "cache",
      },
    ];

    expect(buildPluginMcpServerItems(plugins, "chrome")).toEqual([
      {
        active: true,
        id: "chrome-devtools-mcp@claude-plugins-official:chrome-devtools",
        name: "chrome-devtools",
        pluginEnabled: true,
        pluginId: "chrome-devtools-mcp@claude-plugins-official",
        pluginMarketplace: "claude-plugins-official",
        pluginName: "chrome-devtools-mcp",
        runtimeServerName: "plugin:chrome-devtools-mcp:chrome-devtools",
      },
    ]);
  });

  it("maps Browser host MCP metadata to the unprefixed node_repl runtime", () => {
    const plugins: ZCodePluginInfo[] = [
      {
        commandRootCount: 0,
        declaredMcpServerNames: [],
        enabled: false,
        hostMcpServerNames: ["node_repl"],
        id: "browser-use@zcode-plugins-official",
        marketplace: "zcode-plugins-official",
        mcpServerNames: [],
        name: "browser-use",
        rootPath: "/plugins/browser-use",
        skillRootCount: 1,
        source: "official",
      },
    ];

    expect(
      buildPluginMcpServerItems(plugins, "node", {
        node_repl: {
          status: "connected",
          toolCount: 3,
          transport: "stdio",
          updatedAt: "2026-07-13T00:00:00.000Z",
        },
      }),
    ).toEqual([
      {
        active: true,
        authorization: undefined,
        error: undefined,
        hostProvided: true,
        id: "browser-use@zcode-plugins-official:node_repl",
        name: "node_repl",
        pluginEnabled: false,
        pluginId: "browser-use@zcode-plugins-official",
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "browser-use",
        runtimeServerName: "node_repl",
        status: "connected",
        toolCount: 3,
      },
    ]);
  });

  it("attaches plugin MCP OAuth authorization from runtime status snapshots", () => {
    const plugins: ZCodePluginInfo[] = [
      {
        commandRootCount: 0,
        declaredMcpServerNames: ["canva"],
        enabled: true,
        id: "canva@zcode-plugins-official",
        marketplace: "zcode-plugins-official",
        mcpServerNames: ["plugin:canva:canva"],
        name: "canva",
        rootPath: "/plugins/canva",
        skillRootCount: 0,
        source: "official",
      },
    ];

    expect(
      buildPluginMcpServerItems(plugins, "canva", {
        "plugin:canva:canva": {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=plugin",
            startedAt: "2026-07-09T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      }),
    ).toEqual([
      {
        active: true,
        authorization: {
          authorizationUrl: "https://auth.example.test/authorize?state=plugin",
          startedAt: "2026-07-09T00:00:00.000Z",
          type: "oauth_authorization_code",
        },
        error: undefined,
        id: "canva@zcode-plugins-official:canva",
        name: "canva",
        pluginEnabled: true,
        pluginId: "canva@zcode-plugins-official",
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "canva",
        runtimeServerName: "plugin:canva:canva",
        status: "connecting",
        toolCount: 0,
      },
    ]);
  });

  it("ignores stale plugin MCP runtime authorization when plugin is disabled", () => {
    const plugins: ZCodePluginInfo[] = [
      {
        commandRootCount: 0,
        declaredMcpServerNames: ["canva"],
        enabled: false,
        id: "canva@zcode-plugins-official",
        marketplace: "zcode-plugins-official",
        mcpServerNames: ["plugin:canva:canva"],
        name: "canva",
        rootPath: "/plugins/canva",
        skillRootCount: 0,
        source: "official",
      },
    ];

    expect(
      buildPluginMcpServerItems(plugins, "canva", {
        "plugin:canva:canva": {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=stale",
            startedAt: "2026-07-09T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      }),
    ).toEqual([
      {
        active: true,
        id: "canva@zcode-plugins-official:canva",
        name: "canva",
        pluginEnabled: false,
        pluginId: "canva@zcode-plugins-official",
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "canva",
        runtimeServerName: "plugin:canva:canva",
      },
    ]);
  });

  describe("buildInstalledPluginDisplayGroups", () => {
    function makeComponents(): ZCodePluginComponentGroup[] {
      return [
        {
          kind: "skill",
          items: [{ name: "brainstorming", description: "Plan first" }, { name: "writing-plans" }],
        },
        { kind: "hook", items: [{ name: "SessionStart" }] },
      ];
    }

    function makePlugin(overrides: Partial<ZCodePluginInfo> = {}): ZCodePluginInfo {
      return {
        commandRootCount: 0,
        enabled: true,
        id: "superpowers@zcode-plugins-official",
        marketplace: "zcode-plugins-official",
        mcpServerNames: [],
        name: "superpowers",
        rootPath: "/cache/superpowers",
        skillCount: 2,
        skillRootCount: 1,
        source: "official",
        ...overrides,
      };
    }

    it("maps authoritative components to display groups with names and descriptions", () => {
      const groups = buildInstalledPluginDisplayGroups(
        makePlugin({ components: makeComponents() }),
      );

      // 固定顺序：skill 在 hook 之前（COMPONENT_KIND_ORDER）。
      expect(groups.map((group) => group.kind)).toEqual(["skill", "hook"]);
      const skillGroup = groups.find((group) => group.kind === "skill");
      // 数量取 items.length，与名称一致（修复「有数量没有名称」）。
      expect(skillGroup?.count).toBe(2);
      expect(skillGroup?.items.map((item) => item.name)).toEqual([
        "brainstorming",
        "writing-plans",
      ]);
      // 描述随名称一并展示（修复旧实现 names.map 丢描述）。
      expect(skillGroup?.items[0]?.description).toBe("Plan first");
      expect(skillGroup?.items[1]?.description).toBeUndefined();
    });

    it("renders components even when the plugin is disabled", () => {
      // 停用插件的 components 依然由 CLI 权威枚举下发，详情弹窗不再整组消失。
      const groups = buildInstalledPluginDisplayGroups(
        makePlugin({ enabled: false, skillCount: 0, components: makeComponents() }),
      );
      const skillGroup = groups.find((group) => group.kind === "skill");
      expect(skillGroup?.items.map((item) => item.name)).toEqual([
        "brainstorming",
        "writing-plans",
      ]);
    });

    it("omits empty groups and returns nothing when components are absent", () => {
      expect(buildInstalledPluginDisplayGroups(makePlugin({ components: [] }))).toEqual([]);
      // 旧 payload 没有 components 字段时安全降级为空。
      expect(buildInstalledPluginDisplayGroups(makePlugin())).toEqual([]);
      expect(
        buildInstalledPluginDisplayGroups(
          makePlugin({ components: [{ kind: "skill", items: [] }] }),
        ),
      ).toEqual([]);
    });
  });
});
