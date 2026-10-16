import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

describe("automation showcase templates", () => {
  it("为会话创建入口提供简短的双语草稿引导", () => {
    expect(zhCN["automations.createViaChat.prompt"]).toBe(
      "每个工作日 9 点，汇总当前项目的代码变更和待跟进事项。",
    );
    expect(enUS["automations.createViaChat.prompt"]).toBe(
      "Every weekday at 9 AM, summarize code changes and follow-ups for this project.",
    );
  });

  it("保留远程模板区的本地化分区标题与空目录提示", () => {
    expect(enUS["automations.moreIdeas"]).toBe("Scheduled task template");
    expect(zhCN["automations.moreIdeas"]).toBe("定时任务模板");
    expect(enUS["automations.templates.unavailable"]).toBe("No templates available");
    expect(zhCN["automations.templates.unavailable"]).toBe("无可用模板");
  });

  it("模板图标使用 Lucide 原生组件与统一描边", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationScheduledTemplateIcon.tsx", import.meta.url),
      "utf8",
    );

    for (const icon of ["Activity", "FileText", "List", "Target"]) {
      expect(source).toContain(icon);
    }
    expect(source).toContain("size={16}");
    expect(source).toContain("strokeWidth={2}");
    expect(source).not.toContain("@/assets/");
    expect(source).not.toContain("maskImage");
  });

  it("自动化面板把 Client Scenes item img 的 Lucide 名称交给两类模板图标", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source.match(/iconName=\{template\.iconName\}/g)).toHaveLength(2);
  });

  it("定时模板与闲时模板一样把时间放在描述下方", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
      "utf8",
    );
    const scheduledTemplates = source.slice(source.indexOf("data-automations-scheduled-templates"));
    const titleRowEnd = scheduledTemplates.indexOf("</div>");
    const scheduleCopy = "describeAutomationCardSchedule(";
    const descriptionCopy = "resolveAutomationTemplateText(template.description";

    expect(scheduledTemplates).toContain("min-h-[114px]");
    expect(scheduledTemplates.slice(0, titleRowEnd)).not.toContain(scheduleCopy);
    expect(scheduledTemplates.indexOf(scheduleCopy)).toBeGreaterThan(
      scheduledTemplates.indexOf(descriptionCopy),
    );
    expect(scheduledTemplates).toContain("line-clamp-2 flex-1 text-ui-base font-normal leading-5");
  });

  it("Client Scenes 加载期间为两个可见模板区渲染两行骨架", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("AutomationTemplateSkeletonGrid");
    expect(source.match(/automationTemplates\.loading \?/g)).toHaveLength(2);
  });

  it("Client Scenes 目录为空时为定时与闲时模板区显示无可用模板", async () => {
    const source = await readFile(
      new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source.match(/data-automation-template-empty-state/g)).toHaveLength(2);
    expect(source.match(/automations\.templates\.unavailable/g)).toHaveLength(2);
  });
});
