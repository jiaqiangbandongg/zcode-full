import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeGroupedTaskViewNode } from "@zcode/services";
import { CRON_DEFAULT_GROUP_ID } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GroupDragOverlay } from "@/workspace-grouped-tasks/group-drag-overlay.js";

type GroupNode = Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;

function renderOverlay(node: GroupNode) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(GroupDragOverlay, { node }),
    ),
  );
}

function createGroupNode(id: string, title: string): GroupNode {
  return {
    type: "group",
    group: {
      id,
      title,
      color: "blue",
      createdAt: 1,
      updatedAt: 1,
    },
    tasks: [],
  };
}

describe("GroupDragOverlay", () => {
  it("拖动 cron 系统分组时显示本地化标题而不是存储占位名", () => {
    const html = renderOverlay(createGroupNode(CRON_DEFAULT_GROUP_ID, "cron"));

    expect(html).toContain("定时任务");
    expect(html).not.toContain(">cron<");
  });

  it("拖动普通分组时保留用户设置的标题", () => {
    const html = renderOverlay(createGroupNode("custom-group", "研发事项"));

    expect(html).toContain("研发事项");
  });
});
