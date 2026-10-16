// D48-A：闲时侧栏分组收敛为 tasks-index 真实系统分组后的 UI 契约。
// 纯逻辑走 group-title 单测；组件接线沿用仓库惯例做源码断言。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
} from "@zcode/shared";
import { getTaskGroupDisplayTitle } from "@/workspace-grouped-tasks/group-title.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("off-peak 系统分组 id 与标题", () => {
  it("shared 常量与 cron 并列且互不相同", () => {
    expect(OFF_PEAK_DEFAULT_GROUP_ID).toBe("zcode-default-group-off-peak");
    expect(OFF_PEAK_DEFAULT_GROUP_ID).not.toBe(CRON_DEFAULT_GROUP_ID);
  });

  it("getTaskGroupDisplayTitle 本地化两个系统分组并透传普通分组标题", () => {
    const titles = { cron: "定时任务", offPeak: "闲时任务" };
    expect(
      getTaskGroupDisplayTitle({ id: CRON_DEFAULT_GROUP_ID, title: "cron" }, titles),
    ).toBe("定时任务");
    expect(
      getTaskGroupDisplayTitle(
        { id: OFF_PEAK_DEFAULT_GROUP_ID, title: "off-peak" },
        titles,
      ),
    ).toBe("闲时任务");
    expect(
      getTaskGroupDisplayTitle({ id: "custom", title: "My Group" }, titles),
    ).toBe("My Group");
  });

  it("侧栏组标题的 i18n key 在两个语言包都存在", () => {
    expect(enUS["offPeak.sidebar.groupTitle"]).toBe("Idle-time tasks");
    expect(zhCN["offPeak.sidebar.groupTitle"]).toBeTruthy();
  });
});

describe("grouped UI 收敛接线（源码断言）", () => {
  it("GroupItem 用 isSystemGroup 统一裁剪改名/解散，标题走本地化", () => {
    const source = readSource(
      "packages/ui/src/workspace-grouped-tasks/group-item.tsx",
    );
    expect(source).toContain("OFF_PEAK_DEFAULT_GROUP_ID");
    expect(source).toContain("const isSystemGroup = isCronGroup || isOffPeakGroup;");
    expect(source).not.toContain("{isCronGroup ? null : (");
    expect(source.match(/\{isSystemGroup \? null : \(/g)).toHaveLength(2);
    expect(source).toContain('offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" })');
  });

  it("sticky header 对系统分组裁剪解散项（修掉 cron 存量缺口）", () => {
    const source = readSource(
      "packages/ui/src/workspace-grouped-tasks/sticky-group-header.tsx",
    );
    expect(source).toContain("OFF_PEAK_DEFAULT_GROUP_ID");
    expect(source).toContain("isSystemGroup ? null : (");
  });

  it("Section 把闲时组头「+」路由到 Automations，且投影去重已退役", () => {
    const source = readSource("packages/ui/src/WorkspaceGroupedTasksSection.tsx");
    expect(source).toContain("node.group.id === OFF_PEAK_DEFAULT_GROUP_ID");
    expect(source).toContain("onOpenAutomations?.()");
    expect(source).not.toContain("filterGroupedTaskViewForOffPeakSessions");
    expect(source).not.toContain("useOffPeakTaskStore");
    expect(source).not.toContain("excludeOffPeakSessions");
  });

  it("拖拽浮层与 sticky header 的标题同样本地化闲时组", () => {
    for (const relativePath of [
      "packages/ui/src/workspace-grouped-tasks/group-drag-overlay.tsx",
      "packages/ui/src/workspace-grouped-tasks/sticky-group-header.tsx",
    ]) {
      expect(readSource(relativePath)).toContain(
        'offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" })',
      );
    }
  });
});
