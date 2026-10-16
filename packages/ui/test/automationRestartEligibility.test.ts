import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canRestartAutomation,
  canToggleAutomation,
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
  resolveAutomationDetailNavigation,
  resolveAutomationTabNavigation,
  resolveAutomationDetailTarget,
  resolveAutomationTemplateVisibility,
  resolveAutomationTabAfterOffPeakChange,
  resolveVisibleAutomationTabs,
} from "@/settings/AutomationsSection.js";

const automationsSectionSource = readFileSync(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
);
const automationEditViewSource = readFileSync(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("canRestartAutomation", () => {
  it("只允许 failed 定时任务展示重启入口", () => {
    expect(canRestartAutomation({ lifecycleStatus: "failed" })).toBe(true);
    expect(canRestartAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "active" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "paused" })).toBe(false);
  });

  it("completed 和 failed 终态不展示暂停或恢复入口", () => {
    expect(canToggleAutomation({ lifecycleStatus: "active" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "paused" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canToggleAutomation({ lifecycleStatus: "failed" })).toBe(false);
  });

  it("重复立即运行会映射到正在运行提示", () => {
    expect(getAutomationRunNowToastId("queued")).toBe("automations.runNowQueued");
    expect(getAutomationRunNowToastId("duplicate")).toBe(
      "automations.runNowAlreadyRunning",
    );
    expect(getAutomationRunNowToastId("failed")).toBe("automations.runNowFailed");
  });

  it("立即运行入口只跟随当前请求的瞬时 busy 状态", () => {
    const menuStart = automationsSectionSource.indexOf(
      "function AutomationActionsMenu",
    );
    const menuEnd = automationsSectionSource.indexOf(
      "export function AutomationsSection",
      menuStart,
    );
    const menuSource = automationsSectionSource.slice(menuStart, menuEnd);

    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(menuSource).toContain("disabled={busy}");
    expect(menuSource).not.toContain("runNowDisabled");
    expect(automationsSectionSource).not.toContain(
      "runNowBlockedAutomationIds",
    );
    expect(automationEditViewSource).not.toContain("runNowDisabled");
  });

  it("管理操作失败映射为产品文案，不直接展示 RPC 原文", () => {
    expect(getAutomationActionErrorToastId("create")).toBe("automations.error.create");
    expect(getAutomationActionErrorToastId("update")).toBe("automations.error.update");
    expect(getAutomationActionErrorToastId("toggle")).toBe("automations.error.toggle");
    expect(getAutomationActionErrorToastId("restart")).toBe("automations.error.restart");
    expect(getAutomationActionErrorToastId("delete")).toBe("automations.error.delete");
    expect(
      getAutomationCreateErrorToastId(
        "[AUTOMATION_CREATE_LIMIT_REACHED] automation limit reached",
      ),
    ).toBe("automations.error.createLimit");
    expect(getAutomationCreateErrorToastId("rpc unavailable")).toBe(
      "automations.error.create",
    );
  });

  it("会话创建卡片按 automationId 定位对应详情", () => {
    const target = { automationId: "automation-target" } as never;
    const other = { automationId: "automation-other" } as never;

    expect(resolveAutomationDetailTarget([other, target], " automation-target ")).toBe(target);
    expect(resolveAutomationDetailTarget([other], "automation-target")).toBeNull();
    expect(resolveAutomationDetailTarget([target], undefined)).toBeNull();
  });

  it("详情导航等待列表完成，并在目标不存在时进入可消费的失败终态", () => {
    const target = { automationId: "automation-target" } as never;

    expect(resolveAutomationDetailNavigation([], "automation-target", false)).toEqual({
      status: "pending",
    });
    expect(resolveAutomationDetailNavigation([target], "automation-target", true)).toEqual({
      status: "found",
      target,
    });
    expect(resolveAutomationDetailNavigation([], "automation-target", true)).toEqual({
      status: "missing",
    });
  });

  it("后台关闭闲时灰度后只保留 Scheduled tab", () => {
    expect(
      resolveVisibleAutomationTabs({
        hasAnyTasks: true,
        offPeakVisible: false,
      }),
    ).toEqual(["scheduled"]);
  });

  it("仅在闲时灰度可见或有闲时存量时展示 Idle tab", () => {
    expect(
      resolveVisibleAutomationTabs({
        hasAnyTasks: true,
        offPeakVisible: true,
      }),
    ).toEqual(["scheduled", "idle"]);
    expect(
      resolveVisibleAutomationTabs({
        hasAnyTasks: false,
        offPeakVisible: true,
      }),
    ).toEqual([]);
  });

  it("灰度关闭时将已选中的 Idle tab 收敛回 Scheduled", () => {
    expect(resolveAutomationTabAfterOffPeakChange("idle", false)).toBe("scheduled");
    expect(resolveAutomationTabAfterOffPeakChange("scheduled", false)).toBe("scheduled");
    expect(resolveAutomationTabAfterOffPeakChange("idle", true)).toBe("idle");
  });

  it("仅在 tabs 数据就绪且 Idle tab 可见时应用 OFFPEAK 导航", () => {
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: false,
        visibleTabs: [],
      }),
    ).toEqual({ status: "pending" });
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: true,
        visibleTabs: ["scheduled", "idle"],
      }),
    ).toEqual({ status: "settled", tab: "idle" });
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: true,
        visibleTabs: ["scheduled"],
      }),
    ).toEqual({ status: "settled", tab: "scheduled" });
  });

  it("无任务时同时展示可用的闲时模板和定时任务模板", () => {
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: false,
        offPeakCreationEnabled: true,
        tab: "scheduled",
      }),
    ).toEqual({
      showOffPeakTemplates: true,
      showScheduledTemplates: true,
    });
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: false,
        offPeakCreationEnabled: true,
        tab: "idle",
      }),
    ).toEqual({
      showOffPeakTemplates: true,
      showScheduledTemplates: true,
    });
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: false,
        offPeakCreationEnabled: false,
        tab: "scheduled",
      }),
    ).toEqual({
      showOffPeakTemplates: false,
      showScheduledTemplates: true,
    });
  });

  it("有任务时继续按 Scheduled 和 Idle tab 分流模板", () => {
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: true,
        offPeakCreationEnabled: true,
        tab: "scheduled",
      }),
    ).toEqual({
      showOffPeakTemplates: false,
      showScheduledTemplates: true,
    });
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: true,
        offPeakCreationEnabled: true,
        tab: "idle",
      }),
    ).toEqual({
      showOffPeakTemplates: true,
      showScheduledTemplates: false,
    });
  });
});
