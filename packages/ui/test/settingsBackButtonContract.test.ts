import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const secondarySurfaces = [
  "CommandsSection.tsx",
  "HookForm.tsx",
  "MemorySettingsViewer.tsx",
  "SubagentsSection.tsx",
  "McpSettingsSection.tsx",
  "PluginStoreDetailView.tsx",
] as const;

const secondaryBackMessageIds = [
  "settings.plugins.store.back",
  "settings.commands.backToList",
  "settings.hooks.backToList",
  "settings.subagents.backToList",
  "settings.mcp.form.backToList",
] as const;

describe("settings secondary navigation", () => {
  it("二级设置页由标题栏面包屑导航，不再渲染页内返回按钮", async () => {
    for (const fileName of secondarySurfaces) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source, fileName).not.toContain("<SettingsBackButton");
    }
  });

  it("自动化、闲时任务、模型购买与升级返回入口保持独立", async () => {
    const automation = await readFile(
      new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
      "utf8",
    );
    const offPeak = await readFile(
      new URL("../src/settings/OffPeakEditView.tsx", import.meta.url),
      "utf8",
    );
    // 原生购买面板已下线（购买走 webview 弹窗），返回入口契约只保留闲时任务与升级按钮。
    const upgrade = await readFile(
      new URL(
        "../src/settings/model-provider-section/CodingPlanStatusActions.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(automation).not.toContain("SettingsBackButton");
    expect(offPeak).not.toContain("SettingsBackButton");
    expect(upgrade).not.toContain("SettingsBackButton");
  });

  it("所有二级设置页返回文案不附带业务对象", () => {
    for (const messageId of secondaryBackMessageIds) {
      expect(zhCN[messageId], messageId).toBe("返回");
      expect(enUS[messageId], messageId).toBe("Back");
    }
  });
});
