import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  appendLocalCustomizeTemplate,
  resolveOffPeakTemplateText,
} from "@/settings/automationTemplateCatalog.js";

describe("Automations terminology", () => {
  it("localizes the top-level area as Automations / 自动化", () => {
    expect(enUS["workspace.openScheduledSettings"]).toBe("Automations");
    expect(enUS["settings.automations.title"]).toBe("Automations");
    expect(zhCN["workspace.openScheduledSettings"]).toBe("自动化");
    expect(zhCN["settings.automations.title"]).toBe("自动化");
  });

  it("keeps 定时任务 for the scheduled-task subtype", () => {
    expect(zhCN["automations.list.title"]).toBe("定时任务");
    expect(zhCN["offPeak.tabs.scheduled"]).toBe("定时任务");
    expect(zhCN["taskList.cronTaskLabel"]).toBe("定时任务");
  });

  it("keeps the empty-state description focused on task creation modes", () => {
    expect(enUS["automations.description"]).toBe(
      "Schedule recurring tasks or queue background work that runs during idle time.",
    );
    expect(zhCN["automations.description"]).toBe("创建定时任务，或排队在闲时算力空闲时后台执行。");
  });

  it("keeps idle-time permissions on the main conversation vocabulary", () => {
    const modeValues = ["build", "edit", "plan", "yolo"] as const;

    expect(modeValues.map((value) => zhCN[`mode.label.glm.${value}`])).toEqual([
      "变更前确认",
      "自动编辑",
      "计划模式",
      "完全访问",
    ]);
    expect(modeValues.map((value) => enUS[`mode.label.glm.${value}`])).toEqual([
      "Ask before changes",
      "Edit automatically",
      "Plan mode",
      "Full access",
    ]);
    for (const value of modeValues) {
      expect(zhCN[`offPeak.mode.${value}`]).toBeUndefined();
      expect(enUS[`offPeak.mode.${value}`]).toBeUndefined();
    }
  });

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

  it("does not retain locale entries for deleted static template catalogs", () => {
    const removedPrefixes = [
      "automations.template.",
      "offPeak.newTask.template.standupGitSummary.",
      "offPeak.newTask.template.ciFlakyReport.",
      "offPeak.newTask.template.documentationSyncCheck.",
    ];

    for (const messages of [enUS, zhCN]) {
      expect(
        Object.keys(messages).some((key) =>
          removedPrefixes.some((prefix) => key.startsWith(prefix)),
        ),
      ).toBe(false);
    }
  });

  it("uses action labels for scheduled and idle task creation", () => {
    expect(enUS["automations.createManually"]).toBe("Create scheduled task");
    expect(zhCN["automations.createManually"]).toBe("创建定时任务");
    expect(enUS["automations.createViaChat"]).toBe("Create in chat");
    expect(zhCN["automations.createViaChat"]).toBe("去会话中创建");
    expect(enUS["offPeak.createButton"]).toBe("Create idle-time task");
    expect(zhCN["offPeak.createButton"]).toBe("创建闲时任务");
  });

  it("removes the idle-time form queue guidance copy", () => {
    expect(enUS["offPeak.form.idleTimeLabel"]).toBeUndefined();
    expect(enUS["offPeak.form.scheduleHint"]).toBeUndefined();
    expect(zhCN["offPeak.form.idleTimeLabel"]).toBeUndefined();
    expect(zhCN["offPeak.form.scheduleHint"]).toBeUndefined();
  });

  it("uses the approved pause re-queue guidance without confirmation copy", () => {
    expect(enUS["offPeak.action.pauseHint"]).toBe(
      "Tasks paused beyond the queue wait time will be placed back in the queue",
    );
    expect(zhCN["offPeak.action.pauseHint"]).toBe(
      "暂停时长超过队列等待时限的任务，将会被重新放回队列。",
    );
    expect(enUS["offPeak.pause.title"]).toBeUndefined();
    expect(enUS["offPeak.pause.description"]).toBeUndefined();
    expect(zhCN["offPeak.pause.title"]).toBeUndefined();
    expect(zhCN["offPeak.pause.description"]).toBeUndefined();
  });

  it("uses an explicit create action on the idle-time primary button", () => {
    expect(enUS["offPeak.createButton"]).toBe("Create idle-time task");
    expect(zhCN["offPeak.createButton"]).toBe("创建闲时任务");
  });

  it("uses the approved idle-time delete confirmation copy", () => {
    expect(enUS["offPeak.delete.title"]).toBe("Delete this idle-time task?");
    expect(enUS["offPeak.delete.description"]).toBe(
      "This action can't be undone. If the task is currently queued or running, it will stop immediately.",
    );
    expect(enUS["offPeak.delete.confirm"]).toBe("Delete idle-time task");
    expect(zhCN["offPeak.delete.title"]).toBe("删除此闲时任务？");
    expect(zhCN["offPeak.delete.description"]).toBe(
      "此操作无法撤销。如果任务当前正在排队或运行中，将立即停止。",
    );
    expect(zhCN["offPeak.delete.confirm"]).toBe("删除闲时任务");
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

  it("uses productized discard-draft copy for both task types", () => {
    expect(enUS["automations.unsaved.title"]).toBe("Discard scheduled task draft?");
    expect(enUS["automations.unsaved.description"]).toBe(
      "Your changes to this scheduled task will be lost",
    );
    expect(zhCN["automations.unsaved.title"]).toBe("丢弃定时任务的草稿？");
    expect(zhCN["automations.unsaved.description"]).toBe("你对这个定时任务的更改将会丢失");
    expect(zhCN["automations.unsaved.discard"]).toBe("丢弃");
    expect(zhCN["offPeak.discard.title"]).toBe("丢弃闲时任务的草稿？");
    expect(zhCN["offPeak.discard.description"]).toBe("你对当前闲时任务的更改将会丢失。");
    expect(zhCN["offPeak.discard.confirm"]).toBe("丢弃");
    expect(enUS["offPeak.discard.title"]).toBe("Discard Idle-time task draft?");
    expect(enUS["offPeak.discard.description"]).toBe(
      "Your changes to the current idle-time task will be lost.",
    );
    expect(enUS["offPeak.discard.confirm"]).toBe("Discard");
  });
});
