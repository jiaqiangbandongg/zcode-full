import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveExamplePromptDocumentIcon } from "@/settings/PluginStoreDetailView.js";

describe("Plugin detail header layout", () => {
  it("maps document examples to the bundled product icons", () => {
    expect(resolveExamplePromptDocumentIcon("把我的笔记整理成一份排版好的 Word 文档")).toBe(
      "documents",
    );
    expect(resolveExamplePromptDocumentIcon("把这份 PDF 里的表格提取成电子表格")).toBe(
      "pdf",
    );
    expect(resolveExamplePromptDocumentIcon("用这份 CSV 做一份带图表的 Excel 工作簿")).toBe(
      "spreadsheets",
    );
    expect(resolveExamplePromptDocumentIcon("Summarize this attachment")).toBe("documents");
  });

  it("keeps the name and primary actions in one row with description below", () => {
    const source = readFileSync(
      "packages/ui/src/settings/PluginStoreDetailView.tsx",
      "utf8",
    );

    expect(source).toContain('data-testid="plugin-store-title-actions"');
    expect(source).toContain('data-testid="plugin-store-description"');
    expect(source).toMatch(
      /data-testid="plugin-store-title-actions"[\s\S]*?<h1[\s\S]*?PluginStoreItemMenu[\s\S]*?plugin-store-try-now/,
    );
    expect(source).not.toContain("PluginStoreEnabledSwitch");
    expect(source.indexOf('data-testid="plugin-store-description"')).toBeGreaterThan(
      source.indexOf('data-testid="plugin-store-title-actions"'),
    );
    expect(source).toMatch(
      /PluginStoreItemMenu[\s\S]*?triggerVariant="outline"[\s\S]*?triggerSize="icon-lg"/,
    );
    const tryNowButton = source.match(
      /<Button[\s\S]*?data-testid="plugin-store-try-now"[\s\S]*?<\/Button>/,
    )?.[0];
    expect(tryNowButton).toContain('size="lg"');
    expect(tryNowButton).not.toContain('className="rounded-full"');
    expect(source).toMatch(/PluginStoreInstallButton[\s\S]*?size="lg"/);
  });
});
