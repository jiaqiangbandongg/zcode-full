import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const automationIconsSource = await readFile(
  new URL("../src/settings/AutomationIcons.tsx", import.meta.url),
  "utf8",
);
const automationsSectionSource = await readFile(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
);
const offPeakTaskListSource = await readFile(
  new URL("../src/settings/OffPeakTaskList.tsx", import.meta.url),
  "utf8",
);

describe("automation Lucide icon contract", () => {
  it("统一使用 Lucide 24px viewBox 与 2px 描边，不再加载裁切 Figma 资源", () => {
    expect(automationIconsSource).toContain('from "lucide-react"');
    expect(automationIconsSource).toContain("size: 16");
    expect(automationIconsSource).toContain("strokeWidth: 2");
    expect(automationIconsSource).not.toContain("@/assets/");
    expect(automationIconsSource).not.toContain("maskImage");
  });

  it("任务操作使用稳定的 Lucide 语义映射", () => {
    for (const icon of [
      "CirclePlay",
      "CircleStop",
      "Ellipsis",
      "ExternalLink",
      "Pencil",
      "Play",
      "RefreshCw",
      "Square",
      "Trash2",
    ]) {
      expect(automationIconsSource).toContain(icon);
    }

    expect(automationsSectionSource).toContain("<AutomationEditActionIcon");
    expect(automationsSectionSource).toContain("<AutomationRunNowIcon");
    expect(automationsSectionSource).toContain(
      "paused: { icon: AutomationPausedIcon",
    );
  });

  it("取消任务与首页 Chat 暂停按钮使用同一枚实心 Square 图标", () => {
    expect(automationIconsSource).toContain(
      "export function AutomationCancelActionIcon",
    );
    expect(automationIconsSource).toContain('fill="currentColor"');
    expect(offPeakTaskListSource).toContain("<AutomationCancelActionIcon");
    expect(offPeakTaskListSource).toContain(
      'className="size-4 fill-current"',
    );
    expect(offPeakTaskListSource).not.toMatch(
      /<X[\s\S]*offPeak\.action\.cancel/,
    );
  });
});
