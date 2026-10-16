import { readSourceTextAsync } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

describe("settings skill scope badge", () => {
  it("reuses the Skills navigation icon for list items", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SkillsSection.tsx", import.meta.url),
    );
    expect(source).toContain('<WandSparkles className="size-4"');
    expect(source).not.toContain('<Box className="size-4"');
  });

  it("does not repeat scope metadata beside the skill name in Plugin", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SkillsSection.tsx", import.meta.url),
    );

    expect(source).not.toContain("<Badge");
    expect(source).not.toContain("data-skill-scope");
    expect(source).toContain('case "workspace"');
    expect(source).toContain('case "plugin"');
    // c0a58959fc 起插件 label 统一走 marketplace listing 解析（同名插件跨市场保持独立
    // label），skill 分组标题由 listing 元数据解析，不再使用 canonical slug 直出。
    expect(source).toContain("resolvePluginDisplayName(");
    expect(source).toContain("name: group.label,");
    expect(source).not.toContain("pluginManagedBadge");
    expect(source).not.toContain("pluginManagedHint");
  });
});
