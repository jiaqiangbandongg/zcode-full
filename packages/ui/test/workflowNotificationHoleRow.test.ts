// 留白通知行（docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
// 笔图标、三态种类词按 run 投影的 holes 翻转、主文本 `· run · 留白名` + 类型徽标、展开体的提示 /
// 位置 / 类型 / 草稿路径 / 等待时长 / run 链接。永不 shimmer。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlock: ({ code }: { code: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

// eslint-disable-next-line import/first -- 必须在 code-block mock 之后再引入被测组件。
import {
  WorkflowNotificationToolRow,
  type WorkflowNotificationToolRowProps,
} from "@/v4/WorkflowNotificationToolRow.js";
// eslint-disable-next-line import/first -- 同上。
import { holeRowState } from "@/v4/WorkflowNotificationHoleRow.js";

const HOLE = {
  kind: "hole" as const,
  siteId: "hole#1",
  ordinal: 1,
  name: "决定分组",
  type: "Plan",
  prompt: "侦察结果如下，请补全这一段。",
  draftPath: "/w/.zcode/workflow-drafts/flaky.dwf.ts",
  line: 12,
  before: "探索",
  after: "执行",
  reachedAt: Date.now() - 3 * 60_000,
};

function render(
  props: Partial<WorkflowNotificationToolRowProps>,
  locale: "en-US" | "zh-CN" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowNotificationToolRow, {
        notification: HOLE,
        runName: "flaky-hunt",
        testIdKey: "turn-1:1",
        theme: "system",
        ...props,
      } as WorkflowNotificationToolRowProps),
    ),
  );
}

describe("holeRowState", () => {
  it("run 不在场 → left；在场且 waiting → waiting；在场且 filled / 不在表里 → filled / left", () => {
    expect(holeRowState(undefined, "hole#1")).toBe("left");
    expect(
      holeRowState([{ siteId: "hole#1", ordinal: 1, name: "n", state: "waiting" }], "hole#1"),
    ).toBe("waiting");
    expect(
      holeRowState([{ siteId: "hole#1", ordinal: 1, name: "n", state: "filled" }], "hole#1"),
    ).toBe("filled");
    expect(holeRowState([], "hole#1")).toBe("left");
  });
});

describe("WorkflowNotificationToolRow — hole", () => {
  it("三态种类词：等待补全 / 已补全 / 中性", () => {
    const waiting = render({
      holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "waiting" }],
    });
    expect(waiting).toContain("工作流留白 · 等待补全");
    expect(waiting).toContain('data-hole-state="waiting"');
    expect(
      render({ holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "filled" }] }),
    ).toContain("留白已补全");
    expect(render({})).toContain("工作流留白");
    expect(render({}, "en-US")).toContain("Workflow left a hole");
    expect(
      render(
        { holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "waiting" }] },
        "en-US",
      ),
    ).toContain("Workflow waiting for code");
  });

  it("主文本：run 名与留白名，不画类型；行永不 shimmer", () => {
    const html = render({});
    expect(html).toContain("flaky-hunt");
    expect(html).toContain('data-testid="workflow-hole-notification-name"');
    expect(html).toContain("决定分组");
    expect(html).not.toContain("workflow-hole-type");
    expect(html).not.toContain("Plan");
    expect(html).not.toContain("animate-pulse");
  });

  it("展开体：提示全文、位于两站之间、草稿路径:L 行、等待时长、run 链接；不写须返回的类型", () => {
    const html = render({
      forceOpen: true,
      holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "waiting" }],
      onOpenRun: () => undefined,
    });
    expect(html).toContain("侦察结果如下，请补全这一段。");
    expect(html).toContain("留白位于「探索」之后、「执行」之前；");
    expect(html).not.toContain("补全须返回");
    expect(html).not.toContain("Plan");
    expect(html).toContain("/w/.zcode/workflow-drafts/flaky.dwf.ts:L12");
    expect(html).toContain('data-testid="workflow-hole-notification-waited"');
    expect(html).toContain("等待中 · 3 分钟前");
    // run 链接沿用既有词条 `chat.toolCall.workflow.openRunDetails`。
    expect(html).toContain("查看实例详情");
  });

  it("已补全的行不写等待时长；只有一侧邻站时换措辞", () => {
    const filled = render({
      forceOpen: true,
      notification: { ...HOLE, before: undefined, after: "执行" },
      holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "filled" }],
    });
    expect(filled).not.toContain('data-testid="workflow-hole-notification-waited"');
    expect(filled).toContain("留白位于「执行」之前；");
  });
});
