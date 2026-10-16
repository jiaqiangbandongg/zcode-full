import { describe, expect, it } from "vitest";
import type { ClientSceneConfig } from "@zcode/services";
import {
  appendLocalCustomizeTemplate,
  materializeOffPeakTemplateDraft,
  materializeScheduledTemplateDraft,
  mapClientScenesToAutomationTemplates,
  resolveOffPeakTemplateText,
  resolveAutomationTemplateText,
} from "@/settings/automationTemplateCatalog.js";

function createScenes(cronExpr = "0 9 * * 1-5"): ClientSceneConfig[] {
  return [
    {
      namespace: "zcode",
      scene: "scheduled-task",
      options: {
        prompts: {
          id: "scheduled-prompts",
          type: "prompts",
          contents: { cn: "定时任务模板", en: "Scheduled task template" },
          items: [
            {
              id: "item-morningDevBrief",
              type: "prompts",
              contents: { cn: "中文定时指令", en: "English scheduled prompt" },
              labels: { cn: "晨会动态", en: "Morning dev brief" },
              on_finish: null,
              img: null,
              defaults: { cronExpr: ["item-morningDevBrief-cronExpr"] },
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
        cronExpr: {
          id: "scheduled-cron",
          type: "cronExpr",
          contents: { cn: "调度规则", en: "Schedule" },
          items: [
            {
              id: "item-morningDevBrief-cronExpr",
              type: "cronExpr",
              contents: { cn: cronExpr, en: cronExpr },
              // 服务端 label 只作配置说明，外显必须由 contents 中的 cron 本地解析。
              labels: { cn: "错误的服务端外显", en: "Wrong server display" },
              on_finish: null,
              img: null,
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
      },
      created_at: 0,
      updated_at: 0,
    },
    {
      namespace: "zcode",
      scene: "off-peak-task",
      options: {
        prompts: {
          id: "off-peak-prompts",
          type: "prompts",
          contents: { cn: "闲时任务模板", en: "Idle-time task template" },
          items: [
            {
              id: "item-ciFlakyReport",
              type: "prompts",
              contents: { cn: "中文闲时指令", en: "English idle prompt" },
              labels: { cn: "CI 报告", en: "CI report" },
              on_finish: null,
              img: null,
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
      },
      created_at: 0,
      updated_at: 0,
    },
  ] as ClientSceneConfig[];
}

describe("Client Scenes automation template catalog", () => {
  it("maps scheduled-task defaults to cron contents and never keeps cron labels", () => {
    const result = mapClientScenesToAutomationTemplates(
      createScenes(),
      (cronExpr) => cronExpr === "0 9 * * 1-5",
    );

    expect(result.scheduled).toEqual([
      expect.objectContaining({
        id: "item-morningDevBrief",
        title: { cn: "晨会动态", en: "Morning dev brief" },
        prompt: { cn: "中文定时指令", en: "English scheduled prompt" },
        cronExpr: "0 9 * * 1-5",
        icon: "target",
      }),
    ]);
    expect(JSON.stringify(result.scheduled)).not.toContain("错误的服务端外显");
    expect(JSON.stringify(result.scheduled)).not.toContain("Wrong server display");
  });

  it("keeps prompt item img as the Lucide icon name for both task catalogs", () => {
    const scenes = createScenes();
    scenes[0]!.options.prompts!.items![0]!.img = "  calendar-clock  ";
    scenes[0]!.options.prompts!.items![0]!.imgs = {
      cn: "https://cdn.example.com/scheduled-template-cn.svg",
    };
    scenes[1]!.options.prompts!.items![0]!.img = "activity";

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.scheduled[0]).toEqual(
      expect.objectContaining({
        iconName: "calendar-clock",
        icon: "target",
      }),
    );
    expect(result.offPeak[0]).toEqual(
      expect.objectContaining({
        iconName: "activity",
        icon: "ciFlakyReport",
      }),
    );
  });

  it("rejects a missing or invalid cron before the template can enter creation", () => {
    const invalid = mapClientScenesToAutomationTemplates(createScenes("invalid cron"), () => false);
    const missingReferenceScenes = createScenes();
    const scheduledPrompt = missingReferenceScenes[0]!.options.prompts!.items![0]!;
    scheduledPrompt.defaults = { cronExpr: ["missing-cron-item"] };
    const missing = mapClientScenesToAutomationTemplates(missingReferenceScenes, () => true);

    expect(invalid.scheduled).toEqual([]);
    expect(invalid.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
    expect(missing.scheduled).toEqual([]);
    expect(missing.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
  });

  it("rejects a service-valid cron that the Automation editor cannot round-trip", () => {
    const result = mapClientScenesToAutomationTemplates(createScenes("0 0 9 * * 1-5"), () => true);

    expect(result.scheduled).toEqual([]);
    expect(result.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
  });

  it("rejects scheduled and idle templates whose localized titles are both blank", () => {
    const scenes = createScenes();
    scenes[0]!.options.prompts!.items![0]!.labels = { cn: " ", en: "" };
    scenes[1]!.options.prompts!.items![0]!.labels = { cn: "", en: "  " };

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.scheduled).toEqual([]);
    expect(result.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
    expect(result.offPeak).toEqual([]);
  });

  it("keeps the Automations idle catalog remote-only", () => {
    const result = mapClientScenesToAutomationTemplates(createScenes(), () => true);

    expect(result.offPeak).toEqual([
      expect.objectContaining({
        id: "item-ciFlakyReport",
        title: { cn: "CI 报告", en: "CI report" },
        prompt: { cn: "中文闲时指令", en: "English idle prompt" },
        customize: false,
        icon: "ciFlakyReport",
      }),
    ]);
  });

  it("prefers idle template descs for homepage display while preserving other contents fields", () => {
    const scenes = createScenes();
    scenes[1]!.options.prompts!.items![0]!.descs = {
      cn: "中文闲时描述",
      en: "English idle description",
    };

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.offPeak[0]).toEqual(
      expect.objectContaining({
        homepageDescription: { cn: "中文闲时描述", en: "English idle description" },
        description: { cn: "中文闲时指令", en: "English idle prompt" },
        prompt: { cn: "中文闲时指令", en: "English idle prompt" },
      }),
    );
  });

  it("falls back from a blank idle desc to contents in the same locale", () => {
    const scenes = createScenes();
    scenes[1]!.options.prompts!.items![0]!.descs = {
      cn: "  ",
      en: "English idle description",
    };

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.offPeak[0]?.homepageDescription).toEqual({
      cn: "中文闲时指令",
      en: "English idle description",
    });
    expect(result.offPeak[0]?.description).toEqual({
      cn: "中文闲时指令",
      en: "English idle prompt",
    });
  });

  it("keeps only the first two ordinary remote templates and appends local Customize last", () => {
    const remoteOnly = mapClientScenesToAutomationTemplates(createScenes(), () => true).offPeak;
    const first = remoteOnly[0]!;
    const remoteCustomize = {
      ...first,
      id: "item-customize",
      title: {},
      description: {},
      prompt: { cn: "", en: "" },
      customize: true,
      icon: "customize" as const,
    };
    const second = { ...first, id: "item-second" };
    const third = { ...first, id: "item-third" };

    expect(
      appendLocalCustomizeTemplate([first, remoteCustomize, second, third]).map(({ id }) => id),
    ).toEqual(["item-ciFlakyReport", "item-second", "customize"]);
    expect(appendLocalCustomizeTemplate([]).map(({ id }) => id)).toEqual(["customize"]);
  });

  it("resolves the local Customize copy through the active i18n formatter", () => {
    const customize = appendLocalCustomizeTemplate([])[0]!;
    const messages = {
      "offPeak.newTask.template.customize.title": "自定义",
      "offPeak.newTask.template.customize.description": "跳过模板，直接告诉它你想做什么。",
    };
    const formatMessage = ({ id }: { id: string }) => messages[id as keyof typeof messages] ?? id;

    expect(resolveOffPeakTemplateText(customize, "title", "zh-CN", formatMessage)).toBe("自定义");
    expect(resolveOffPeakTemplateText(customize, "description", "zh-CN", formatMessage)).toBe(
      "跳过模板，直接告诉它你想做什么。",
    );
    expect(customize.title).toEqual({});
    expect(customize.description).toEqual({});
  });

  it("materializes current-locale primitives that are independent from later catalog refreshes", () => {
    const first = mapClientScenesToAutomationTemplates(createScenes(), () => true);
    const scheduledDraft = materializeScheduledTemplateDraft(first.scheduled[0]!, "zh-CN");
    const offPeakDraft = materializeOffPeakTemplateDraft(first.offPeak[0]!, "zh-CN");

    const refreshedScenes = createScenes();
    refreshedScenes[0]!.options.prompts!.items![0]!.labels.cn = "后台刷新标题";
    refreshedScenes[1]!.options.prompts!.items![0]!.contents.cn = "后台刷新指令";
    mapClientScenesToAutomationTemplates(refreshedScenes, () => true);

    expect(scheduledDraft).toEqual({
      templateId: "item-morningDevBrief",
      title: "晨会动态",
      cronExpr: "0 9 * * 1-5",
      prompt: "中文定时指令",
    });
    expect(offPeakDraft).toEqual({
      templateId: "item-ciFlakyReport",
      title: "CI 报告",
      prompt: "中文闲时指令",
    });
  });

  it("resolves the active locale with a deterministic opposite-language fallback", () => {
    expect(resolveAutomationTemplateText({ cn: "中文", en: "English" }, "zh-CN")).toBe("中文");
    expect(resolveAutomationTemplateText({ en: "English" }, "zh-CN")).toBe("English");
    expect(resolveAutomationTemplateText({ cn: "中文" }, "en-US")).toBe("中文");
  });
});
