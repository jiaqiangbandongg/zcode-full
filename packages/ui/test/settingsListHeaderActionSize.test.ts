import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Commands/Hooks/Subagents/Memory 的头部纯图标按钮已收进共享组件
// SettingsResourceHeaderActions（icon-md）；仍自带图标的页面沿用 icon-lg。
const selfRenderedIconFiles = {
  "McpSettingsSection.tsx": 1,
  "PluginStorePage.tsx": 2,
  "PluginStoreListView.tsx": 1,
  "SkillsSection.tsx": 1,
} as const;

const delegatingSections = [
  "CommandsSection.tsx",
  "HooksSection.tsx",
  "MemorySettingsViewer.tsx",
  "SubagentsSection.tsx",
] as const;

describe("settings list header actions", () => {
  it("纯图标按钮统一使用 outline，共享头部动作用 icon-md", async () => {
    for (const [fileName, expectedCount] of Object.entries(
      selfRenderedIconFiles,
    )) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(
        source.match(/variant="outline"\s+size="icon-lg"/g),
        fileName,
      ).toHaveLength(expectedCount);
    }

    const shared = await readFile(
      new URL("../src/settings/SettingsResourceHeaderActions.tsx", import.meta.url),
      "utf8",
    );
    expect(shared.match(/variant="outline"\s+size="icon-md"/g)).toHaveLength(2);
  });

  it.each(delegatingSections)(
    "%s 头部图标按钮由共享组件渲染",
    async (fileName) => {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("<SettingsResourceHeaderActions");
      expect(source).not.toMatch(/size="icon-lg"/);
    },
  );

  it("插件列表右上角操作按钮使用统一的 8px 间距", async () => {
    const source = await readFile(
      new URL("../src/settings/PluginStorePage.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('className="flex shrink-0 items-center gap-2"');
  });
});
