import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  appendLocalCustomizeTemplate,
  resolveOffPeakTemplateText,
} from "@/settings/automationTemplateCatalog.js";

describe("Automations terminology", () => {
  it("keeps the local Customize fallback copy for Client Scenes failures", () => {
    const customize = appendLocalCustomizeTemplate([])[0]!;
    const format =
      (messages: Record<string, string>) =>
      ({ id }: { id: string }) =>
        messages[id] ?? id;

    expect(resolveOffPeakTemplateText(customize, "title", "zh-CN", format(zhCN))).toBe("自定义");
    expect(resolveOffPeakTemplateText(customize, "title", "en-US", format(enUS))).toBe("Customize");
    expect(
      resolveOffPeakTemplateText(customize, "description", "zh-CN", format(zhCN)),
    ).toBeTruthy();
    expect(
      resolveOffPeakTemplateText(customize, "description", "en-US", format(enUS)),
    ).toBeTruthy();
  });

  it("keeps imminent next-run copy grammatical across locales", () => {
    const englishNextRun = enUS["automations.nextRun"].replace(
      "{when}",
      enUS["automations.time.soon"],
    );
    const chineseNextRun = zhCN["automations.nextRun"].replace(
      "{when}",
      zhCN["automations.time.soon"],
    );

    expect(englishNextRun).toBe("Next run soon");
    expect(chineseNextRun).toBe("下次运行 1 分钟内");
  });
});
