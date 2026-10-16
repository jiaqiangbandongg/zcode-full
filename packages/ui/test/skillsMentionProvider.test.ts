import { describe, expect, it } from "vitest";
import { mapSkillsToMentionItemsForTest } from "../src/mentions/providers/skillsMentionProvider.js";

describe("skills mention provider", () => {
  it("dedupes same-name skills for $ panel and prefers workspace source", () => {
    const items = mapSkillsToMentionItemsForTest([
      {
        id: "claude:user:review:a",
        name: "review",
        description: "user review",
        path: "/home/user/.claude/skills/review/SKILL.md",
        scope: "user",
      },
      {
        id: "claude:plugin:review:b",
        name: "review",
        description: "plugin review",
        path: "/home/user/.claude/plugins/review/skills/review/SKILL.md",
        scope: "plugin",
      },
      {
        id: "claude:workspace:review:c",
        name: "review",
        description: "workspace review",
        path: "/repo/.claude/skills/review/SKILL.md",
        scope: "workspace",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "review",
      value: "review",
      description: "Workspace · workspace review",
      data: {
        scope: "workspace",
        path: "/repo/.claude/skills/review/SKILL.md",
      },
    });
  });

  it("$ panel displays the original frontmatter skill name without formatting", () => {
    const items = mapSkillsToMentionItemsForTest([
      {
        id: "claude:user:agent-browser:a",
        name: "agent-browser",
        description: "browser",
        path: "/home/user/.claude/skills/agent-browser/SKILL.md",
        scope: "user",
      },
    ]);

    expect(items[0]).toMatchObject({
      label: "agent-browser",
      value: "agent-browser",
      keywords: ["agent-browser", "browser", "user"],
    });
  });

  it("localizes bundled plugin skill descriptions for the $ panel", () => {
    const skill = {
      id: "builtin-pdf",
      name: "pdf",
      description: "专业 PDF 工具集",
      path: "/cache/zcode-plugins-official/document-skills/0.1.0/skills/pdf/SKILL.md",
      scope: "plugin" as const,
      pluginName: "document-skills",
    };

    expect(mapSkillsToMentionItemsForTest([skill], "en-US")[0]?.description).toContain(
      "Plugin · Professional PDF toolkit",
    );
    expect(mapSkillsToMentionItemsForTest([skill], "zh-CN")[0]?.description).toContain(
      "插件 · 专业 PDF 工具集",
    );
  });

  it("localizes the official Browser Use tester skill by plugin name", () => {
    const skill = {
      id: "builtin-web-gui-tester",
      name: "web-gui-tester",
      description: "frontmatter fallback",
      path: "/plugins/browser-use/skills/web-gui-tester/SKILL.md",
      scope: "plugin" as const,
      pluginName: "browser-use",
    };

    expect(mapSkillsToMentionItemsForTest([skill], "en-US")[0]?.description).toContain(
      "Plugin · Run pure GUI black-box tests",
    );
    expect(mapSkillsToMentionItemsForTest([skill], "zh-CN")[0]?.description).toContain(
      "插件 · 使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试",
    );
  });
});
