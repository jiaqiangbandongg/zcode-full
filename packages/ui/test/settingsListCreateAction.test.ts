import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 各资源页头部动作已统一由 SettingsResourceHeaderActions 渲染：
// markup 断言落在共享组件上，分区文件只断言委托与传入的 action id。
const delegatingSections = [
  "CommandsSection.tsx",
  "SubagentsSection.tsx",
  "HooksSection.tsx",
  "McpSettingsSection.tsx",
  "SkillsSection.tsx",
] as const;

describe("settings list create actions", () => {
  it("renders the shared create action as a default icon-and-label button", async () => {
    const source = await readFile(
      new URL("../src/settings/SettingsResourceHeaderActions.tsx", import.meta.url),
      "utf8",
    );
    const markerStart = source.indexOf("data-settings-create-action={newActionId}");
    expect(markerStart).toBeGreaterThan(-1);
    const actionStart = source.lastIndexOf("<Button", markerStart);
    const actionEnd = source.indexOf("</Button>", actionStart) + "</Button>".length;
    const action = source.slice(actionStart, actionEnd);

    expect(action).toContain('variant="default"');
    expect(action).toContain('size="default"');
    expect(action).toContain('className="rounded-lg"');
    expect(action).toContain('<Plus data-icon="inline-start"');
    expect(action).toContain("aria-label={newLabel}");
    expect(source).toContain('id: "settings.create.action"');
  });

  it.each(delegatingSections)(
    "%s routes create and import through the shared header actions",
    async (fileName) => {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("<SettingsResourceHeaderActions");
      expect(source).toMatch(/onNew=\{/);
    },
  );

  it("labels the shared overflow import action with a visible menu item", async () => {
    const source = await readFile(
      new URL("../src/settings/SettingsResourceHeaderActions.tsx", import.meta.url),
      "utf8",
    );
    const markerStart = source.indexOf("data-settings-import-action={importActionId}");
    expect(markerStart).toBeGreaterThan(-1);
    const itemStart = source.lastIndexOf("<DropdownMenuItem", markerStart);
    const itemEnd = source.indexOf("</DropdownMenuItem>", itemStart) + "</DropdownMenuItem>".length;
    const item = source.slice(itemStart, itemEnd);

    expect(item).toContain("onSelect={onImport}");
    expect(item).toContain("{importLabel}");
    expect(source).toContain('id: "settings.resourceActions.import"');
  });

  it.each([
    ["McpSettingsSection.tsx", "settings.mcp.import.open", "settings.mcp.create.open"],
    ["SkillsSection.tsx", "settings.skills.import.open", "settings.skills.create.open"],
    ["HooksSection.tsx", undefined, "settings.hooks.add"],
  ] as const)(
    "%s passes its action ids to the shared header actions",
    async (fileName, importActionId, newActionId) => {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      if (importActionId) {
        expect(source).toContain(`importActionId="${importActionId}"`);
      }
      expect(source).toContain(`newActionId="${newActionId}"`);
    },
  );

  it.each([
    ["McpSettingsSection.tsx", "settings.mcp.import.action"],
    ["SkillsSection.tsx", "settings.skills.import.action"],
  ] as const)(
    "%s keeps a visible label on the inline import dialog button",
    async (fileName, messageId) => {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source).toMatch(
        /variant="outline"\s+size="lg"[^]*?<Import data-icon="inline-start"[^]*?id: "[\w.]*import\.action"/,
      );
      expect(source).toContain(`id: "${messageId}"`);
    },
  );

  it("keeps Automations on its dedicated create controls", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("SettingsResourceHeaderActions");
  });

  it("shares the two-item Add menu across plugin pages", async () => {
    const menu = await readFile(
      new URL("../src/settings/PluginAddMenu.tsx", import.meta.url),
      "utf8",
    );
    expect(menu.match(/<DropdownMenuItem[\s>]/g)).toHaveLength(2);
    expect(menu).toContain('id: "pluginCreator.create"');
    expect(menu).toContain('id: "pluginCreator.addMarketplace"');
    for (const file of ["PluginStorePage.tsx", "PluginsSection.tsx"]) {
      const source = await readFile(new URL(`../src/settings/${file}`, import.meta.url), "utf8");
      expect(source).toContain("<PluginAddMenu");
    }
  });

  it("keeps source addition at the end of the marketplace header through the Add menu", async () => {
    const source = await readFile(
      new URL("../src/settings/PluginStorePage.tsx", import.meta.url),
      "utf8",
    );
    const actionStart = source.indexOf("<PluginAddMenu");
    expect(actionStart).toBeGreaterThan(source.indexOf('data-testid="plugin-store-sources-open"'));
    const action = source.slice(actionStart, source.indexOf("/>", actionStart));
    expect(action).toContain("onAddMarketplace={() => {");
    expect(action).toContain("setAddMarketplaceError(null)");
    expect(action).toContain("setAddSourceOpen(true)");
  });
});
