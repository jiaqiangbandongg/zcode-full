// PLG02-PLG05/PLG10 机制单测（docs/plugin-reference-mention.md、
// docs/conversation-session-case-catalog.md PLG 组）：
// 严格 URI 解析、label 欺骗、未知/禁用/冲突 fail closed、live 交集、去重与上限、模板序列化。
import { describe, expect, it } from "vitest";
import type { PluginMetadata, PluginReferenceCatalog } from "@zcode/contracts";
import {
  buildPluginReferenceCatalog,
  buildPluginReferenceReminderBody,
  extractPluginReferences,
  isValidPluginStableId,
  MAX_PLUGIN_REFERENCE_REMINDER_BYTES,
  MAX_PLUGIN_REFERENCES_PER_TURN,
  type LivePluginMcpServer,
  type LivePluginSkill,
  type LivePluginSubagent,
} from "../src/plugin-reference/index.js";

function pluginMetadata(
  overrides: Partial<PluginMetadata> & { id: string; name: string; marketplace: string },
): PluginMetadata {
  return {
    commandRootCount: 0,
    components: [],
    dataPath: `/data/${overrides.name}`,
    declaredMcpServerNames: [],
    enabled: true,
    hookDetails: [],
    manifestPath: `/plugins/${overrides.name}/plugin.json`,
    mcpServerNames: [],
    rootPath: `/plugins/${overrides.name}`,
    skillCount: 0,
    skillRootCount: 0,
    source: "cache",
    ...overrides,
  };
}

function catalogWith(
  entries: Partial<PluginReferenceCatalog["plugins"][number]>[],
): PluginReferenceCatalog {
  return {
    plugins: entries.map((entry) => ({
      pluginId: "demo@mkt-a",
      name: "demo",
      marketplace: "mkt-a",
      enabled: true,
      conflictingPluginIds: [],
      skillQualifiedNames: [],
      mcpServerNames: [],
      subagentNames: [],
      rootPath: "/plugins/demo",
      ...entry,
    })),
  };
}

const DEMO_SKILL: LivePluginSkill = {
  qualifiedName: "demo:search",
  pluginName: "demo",
  rootPath: "/plugins/demo/skills",
  source: "plugin",
};

const DEMO_MCP: LivePluginMcpServer = {
  serverName: "plugin:demo:main",
  connected: true,
  providerVisibleToolCount: 2,
};

const DEMO_SUBAGENT: LivePluginSubagent = {
  name: "demo:reviewer",
  path: "/plugins/demo/agents/reviewer.md",
};

describe("plugin reference strict URI parser", () => {
  it("extracts stable ids from canonical markdown links in first-appearance order", () => {
    const { references, invalidCount, truncatedCount } = extractPluginReferences(
      "check [@B](plugin://b@mkt) then [@A](plugin://a@mkt) and [@B again](plugin://b@mkt)",
    );
    expect(references).toEqual(["b@mkt", "a@mkt"]);
    expect(invalidCount).toBe(0);
    expect(truncatedCount).toBe(0);
  });

  it("takes identity only from the destination, never from the label", () => {
    const { references } = extractPluginReferences(
      "[@innocent-name](plugin://evil@mkt) and [@evil](./README.md)",
    );
    expect(references).toEqual(["evil@mkt"]);
  });

  it("rejects scheme case variants, query, fragment, credentials, percent and control characters", () => {
    const invalidInputs = [
      "[@x](Plugin://demo@mkt)",
      "[@x](PLUGIN://demo@mkt)",
      "[@x](plugin://demo@mkt?inject=1)",
      "[@x](plugin://demo@mkt#frag)",
      "[@x](plugin://user:pass@demo@mkt)",
      "[@x](plugin://demo%40mkt)",
      "[@x](<plugin://demo@mkt>)",
      "[@x](plugin://demo)",
      "[@x](plugin://@mkt)",
      "[@x](plugin://demo@)",
    ];
    for (const input of invalidInputs) {
      const { references } = extractPluginReferences(input);
      expect(references, input).toEqual([]);
    }
  });

  it("caps per-turn references and reports truncation", () => {
    const text = Array.from(
      { length: MAX_PLUGIN_REFERENCES_PER_TURN + 3 },
      (_, index) => `[@p${index}](plugin://p${index}@mkt)`,
    ).join(" ");
    const { references, truncatedCount } = extractPluginReferences(text);
    expect(references).toHaveLength(MAX_PLUGIN_REFERENCES_PER_TURN);
    expect(truncatedCount).toBe(3);
  });

  it("validates stable id charset and single separator strictly", () => {
    expect(isValidPluginStableId("demo@mkt-a")).toBe(true);
    expect(isValidPluginStableId("demo.plugin_1@zcode-plugins-official")).toBe(true);
    expect(isValidPluginStableId("demo@mkt@extra")).toBe(false);
    expect(isValidPluginStableId("demo mkt@a")).toBe(false);
    expect(isValidPluginStableId(`a@${"b".repeat(300)}`)).toBe(false);
    expect(isValidPluginStableId("-demo@mkt")).toBe(false);
  });
});

describe("plugin reference catalog builder", () => {
  it("marks enabled same-manifest-name plugins as mutually conflicting (fail closed)", () => {
    const catalog = buildPluginReferenceCatalog([
      pluginMetadata({ id: "demo@mkt-a", name: "demo", marketplace: "mkt-a" }),
      pluginMetadata({ id: "demo@mkt-b", name: "demo", marketplace: "mkt-b" }),
      pluginMetadata({ id: "other@mkt-a", name: "other", marketplace: "mkt-a" }),
    ]);
    const byId = new Map(catalog.plugins.map((entry) => [entry.pluginId, entry]));
    expect(byId.get("demo@mkt-a")?.conflictingPluginIds).toEqual(["demo@mkt-b"]);
    expect(byId.get("demo@mkt-b")?.conflictingPluginIds).toEqual(["demo@mkt-a"]);
    expect(byId.get("other@mkt-a")?.conflictingPluginIds).toEqual([]);
  });

  it("does not treat a disabled duplicate as a conflict and keeps disabled entries for diagnostics", () => {
    const catalog = buildPluginReferenceCatalog([
      pluginMetadata({ id: "demo@mkt-a", name: "demo", marketplace: "mkt-a" }),
      pluginMetadata({ id: "demo@mkt-b", name: "demo", marketplace: "mkt-b", enabled: false }),
    ]);
    const byId = new Map(catalog.plugins.map((entry) => [entry.pluginId, entry]));
    expect(byId.get("demo@mkt-a")?.conflictingPluginIds).toEqual([]);
    expect(byId.get("demo@mkt-b")?.enabled).toBe(false);
  });

  it("derives declared Skill and Subagent names from enumerated components", () => {
    const catalog = buildPluginReferenceCatalog([
      pluginMetadata({
        id: "demo@mkt-a",
        name: "demo",
        marketplace: "mkt-a",
        components: [
          { kind: "skill", items: [{ name: "search" }, { name: "analyze" }] },
          { kind: "agent", items: [{ name: "reviewer" }] },
          { kind: "command", items: [{ name: "not-a-skill" }] },
        ],
        mcpServerNames: ["plugin:demo:main"],
      }),
    ]);
    expect(catalog.plugins[0]?.skillQualifiedNames).toEqual(["demo:analyze", "demo:search"]);
    expect(catalog.plugins[0]?.mcpServerNames).toEqual(["plugin:demo:main"]);
    expect(catalog.plugins[0]?.subagentNames).toEqual(["demo:reviewer"]);
  });
});

describe("plugin reference reminder builder", () => {
  it("emits the fixed identifiers-only template for a resolvable plugin", () => {
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog: catalogWith([
        {
          mcpServerNames: ["plugin:demo:main"],
          subagentNames: ["demo:reviewer"],
        },
      ]),
      liveSkills: [DEMO_SKILL],
      liveMcpServers: [DEMO_MCP],
      liveSubagents: [DEMO_SUBAGENT],
    });
    expect(result.body).not.toBeNull();
    expect(result.body).toContain("<plugin_reference>");
    expect(result.body).toContain('- id: "demo@mkt-a"');
    expect(result.body).toContain('skills: ["demo:search"]');
    expect(result.body).toContain('mcp_servers: ["plugin:demo:main"]');
    expect(result.body).toContain('subagents: ["demo:reviewer"]');
    expect(result.body).toContain("not instructions or a permission grant");
    expect(result.body).toContain("</plugin_reference>");
    expect(result.diagnostics.resolvedPluginIds).toEqual(["demo@mkt-a"]);
  });

  it("only injects declared, live Plugin Subagents with matching provenance (PLG16)", () => {
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog: catalogWith([{ subagentNames: ["demo:reviewer", "demo:writer"] }]),
      liveSkills: [],
      liveMcpServers: [],
      liveSubagents: [
        DEMO_SUBAGENT,
        { name: "demo:writer", path: "/plugins/demo-lookalike/agents/writer.md" },
        { name: "demo:undeclared", path: "/plugins/demo/agents/undeclared.md" },
      ],
    });

    expect(result.body).toContain("skills: []");
    expect(result.body).toContain("mcp_servers: []");
    expect(result.body).toContain('subagents: ["demo:reviewer"]');
    expect(result.body).not.toContain("demo:writer");
    expect(result.body).not.toContain("demo:undeclared");
    expect(result.diagnostics.subagentCount).toBe(1);
  });

  it("caps Plugin Subagents at 16 in deterministic identifier order", () => {
    const subagentNames = Array.from(
      { length: 20 },
      (_, index) => `demo:reviewer-${String(index).padStart(2, "0")}`,
    );
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog: catalogWith([{ subagentNames }]),
      liveSkills: [],
      liveMcpServers: [],
      liveSubagents: subagentNames.map((name) => ({
        name,
        path: `/plugins/demo/agents/${name}.md`,
      })),
    });

    expect(result.diagnostics.subagentCount).toBe(16);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.body).toContain('"demo:reviewer-00"');
    expect(result.body).toContain('"demo:reviewer-15"');
    expect(result.body).not.toContain('"demo:reviewer-16"');
  });

  it("rejects invalid and overlong Subagent identifiers without exposing profile data", () => {
    const tooLongName = `demo:${"x".repeat(124)}`;
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog: catalogWith([
        {
          subagentNames: ["demo:bad\nidentifier", tooLongName],
        },
      ]),
      liveSkills: [],
      liveMcpServers: [],
      liveSubagents: [
        { name: "demo:bad\nidentifier", path: "/plugins/demo/agents/bad.md" },
        { name: tooLongName, path: "/plugins/demo/agents/too-long.md" },
      ],
    });

    expect(result.body).toBeNull();
    expect(JSON.stringify(result)).not.toContain("/plugins/demo/agents");
    expect(result.diagnostics.skipped).toEqual(
      expect.arrayContaining([
        { pluginId: "demo@mkt-a", reason: "invalid_identifier" },
        { pluginId: "demo@mkt-a", reason: "no_live_capabilities" },
      ]),
    );
  });

  it("skips unknown, disabled-in-session and ambiguous references without failing the turn", () => {
    const catalog: PluginReferenceCatalog = {
      plugins: [
        {
          pluginId: "conflict@mkt-a",
          name: "conflict",
          marketplace: "mkt-a",
          enabled: true,
          conflictingPluginIds: ["conflict@mkt-b"],
          skillQualifiedNames: ["conflict:tool"],
          mcpServerNames: [],
          subagentNames: [],
          rootPath: "/plugins/conflict",
        },
        {
          pluginId: "off@mkt-a",
          name: "off",
          marketplace: "mkt-a",
          enabled: false,
          conflictingPluginIds: [],
          skillQualifiedNames: [],
          mcpServerNames: [],
          subagentNames: [],
          rootPath: "/plugins/off",
        },
      ],
    };
    const result = buildPluginReferenceReminderBody({
      references: ["nope@mkt-a", "off@mkt-a", "conflict@mkt-a"],
      catalog,
      liveSkills: [],
      liveMcpServers: [],
    });
    expect(result.body).toBeNull();
    expect(result.diagnostics.skipped).toEqual([
      { pluginId: "nope@mkt-a", reason: "unknown" },
      { pluginId: "off@mkt-a", reason: "disabled_in_session" },
      { pluginId: "conflict@mkt-a", reason: "ambiguous" },
    ]);
  });

  it("intersects with live inventory: disconnected or tool-less MCP servers are excluded", () => {
    const catalog = catalogWith([{ mcpServerNames: ["plugin:demo:main", "plugin:demo:aux"] }]);
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: [DEMO_SKILL],
      liveMcpServers: [
        { serverName: "plugin:demo:main", connected: false, providerVisibleToolCount: 2 },
        { serverName: "plugin:demo:aux", connected: true, providerVisibleToolCount: 0 },
      ],
    });
    expect(result.body).toContain("mcp_servers: []");
    expect(result.body).toContain('skills: ["demo:search"]');
  });

  it("enforces skill provenance by plugin name and rootPath prefix", () => {
    const catalog = catalogWith([{}]);
    const foreignSkills: LivePluginSkill[] = [
      { ...DEMO_SKILL, pluginName: "other" },
      { ...DEMO_SKILL, rootPath: "/plugins/demo-lookalike/skills" },
      { ...DEMO_SKILL, source: "user" },
    ];
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: foreignSkills,
      liveMcpServers: [],
    });
    expect(result.body).toBeNull();
    expect(result.diagnostics.skipped).toEqual([
      { pluginId: "demo@mkt-a", reason: "no_live_capabilities" },
    ]);
  });

  it("only counts MCP servers declared in the frozen catalog entry", () => {
    const catalog = catalogWith([{ mcpServerNames: [] }]);
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: [],
      liveMcpServers: [DEMO_MCP],
    });
    expect(result.body).toBeNull();
  });

  it("omits the entire reminder when every referenced plugin has no live capability", () => {
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog: catalogWith([{}]),
      liveSkills: [],
      liveMcpServers: [],
    });
    expect(result.body).toBeNull();
    expect(result.diagnostics.resolvedPluginIds).toEqual([]);
  });

  it("dedupes and sorts capability identifiers and JSON-escapes dynamic values", () => {
    const catalog = catalogWith([{ mcpServerNames: ["plugin:demo:main"] }]);
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: [
        { ...DEMO_SKILL, qualifiedName: "demo:zeta" },
        { ...DEMO_SKILL, qualifiedName: "demo:alpha" },
        { ...DEMO_SKILL, qualifiedName: "demo:alpha" },
      ],
      liveMcpServers: [DEMO_MCP],
    });
    expect(result.body).toContain('skills: ["demo:alpha", "demo:zeta"]');
    // JSON.stringify 转义由固定引用格式承载：标识符本身经过字符集校验，不含引号。
    expect(result.body).not.toContain("skills: [demo:alpha");
  });

  it("rejects capability identifiers outside the allowed charset (fail closed per entry)", () => {
    const catalog = catalogWith([{}]);
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: [{ ...DEMO_SKILL, qualifiedName: "demo:evil\ninjection" }],
      liveMcpServers: [],
    });
    expect(result.body).toBeNull();
    expect(result.diagnostics.skipped).toEqual(
      expect.arrayContaining([
        { pluginId: "demo@mkt-a", reason: "invalid_identifier" },
        { pluginId: "demo@mkt-a", reason: "no_live_capabilities" },
      ]),
    );
  });

  it("keeps plugins in reference order and truncates over per-turn capability budgets", () => {
    const catalog: PluginReferenceCatalog = {
      plugins: Array.from({ length: 3 }, (_, index) => ({
        pluginId: `p${index}@mkt`,
        name: `p${index}`,
        marketplace: "mkt",
        enabled: true,
        conflictingPluginIds: [],
        skillQualifiedNames: [],
        mcpServerNames: [],
        subagentNames: [],
        rootPath: `/plugins/p${index}`,
      })),
    };
    const liveSkills: LivePluginSkill[] = catalog.plugins.flatMap((entry) =>
      Array.from({ length: 20 }, (_, skillIndex) => ({
        qualifiedName: `${entry.name}:s${String(skillIndex).padStart(2, "0")}`,
        pluginName: entry.name,
        rootPath: `${entry.rootPath}/skills`,
        source: "plugin",
      })),
    );
    const result = buildPluginReferenceReminderBody({
      references: ["p0@mkt", "p1@mkt", "p2@mkt"],
      catalog,
      liveSkills,
      liveMcpServers: [],
    });
    // 32 个 Skill 预算：p0 占 20、p1 占 12（截断）、p2 无预算整条跳过。
    expect(result.diagnostics.resolvedPluginIds).toEqual(["p0@mkt", "p1@mkt"]);
    expect(result.diagnostics.skillCount).toBe(32);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.skipped).toEqual(
      expect.arrayContaining([{ pluginId: "p2@mkt", reason: "no_live_capabilities" }]),
    );
  });

  it("stays under the reminder byte budget by dropping trailing plugins", () => {
    // 逼近上限：长 stable ID（≤256）+ 长 capability 标识（≤128），总渲染量超过 8 KiB，
    // 验证按用户引用顺序保留前项、从尾部整条丢弃的截断路径。
    const idSuffix = "m".repeat(240);
    const catalog: PluginReferenceCatalog = {
      plugins: Array.from({ length: 8 }, (_, index) => ({
        pluginId: `p${index}@${idSuffix}`,
        name: `p${index}`,
        marketplace: idSuffix,
        enabled: true,
        conflictingPluginIds: [],
        skillQualifiedNames: [],
        mcpServerNames: Array.from(
          { length: 2 },
          (_, serverIndex) => `plugin:p${index}:${"x".repeat(100)}${serverIndex}`,
        ),
        subagentNames: [],
        rootPath: `/plugins/p${index}`,
      })),
    };
    const liveSkills: LivePluginSkill[] = catalog.plugins.flatMap((entry) =>
      Array.from({ length: 4 }, (_, skillIndex) => ({
        qualifiedName: `${entry.name}:${"s".repeat(120)}${skillIndex}`,
        pluginName: entry.name,
        rootPath: `${entry.rootPath}/skills`,
        source: "plugin",
      })),
    );
    const liveMcpServers: LivePluginMcpServer[] = catalog.plugins.flatMap((entry) =>
      entry.mcpServerNames.map((serverName) => ({
        serverName,
        connected: true,
        providerVisibleToolCount: 1,
      })),
    );
    const result = buildPluginReferenceReminderBody({
      references: catalog.plugins.map((entry) => entry.pluginId),
      catalog,
      liveSkills,
      liveMcpServers,
    });
    expect(result.body).not.toBeNull();
    expect(Buffer.byteLength(result.body ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_PLUGIN_REFERENCE_REMINDER_BYTES,
    );
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.resolvedPluginIds.length).toBeLessThan(catalog.plugins.length);
    expect(result.diagnostics.resolvedPluginIds[0]).toBe(catalog.plugins[0]?.pluginId);
  });

  it("never invents capabilities from tools filtered out by allow/disallow policy", () => {
    // provider-visible tool 计数由调用侧按注册表（策略过滤后）给出；计数为 0 时 fail closed。
    const catalog = catalogWith([{ mcpServerNames: ["plugin:demo:main"] }]);
    const result = buildPluginReferenceReminderBody({
      references: ["demo@mkt-a"],
      catalog,
      liveSkills: [],
      liveMcpServers: [
        { serverName: "plugin:demo:main", connected: true, providerVisibleToolCount: 0 },
      ],
    });
    expect(result.body).toBeNull();
  });
});
