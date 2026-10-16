import { describe, expect, it } from "vitest";
import { laneDisplayName } from "../src/components/workflow-graph/lane-name.js";

/**
 * 车道显示名的唯一策略点。它只要一个 formatMessage，不碰 React，所以能在这里直接单测：
 * 文案在渲染时才本地化，投影里存的永远是数据（脚本给的名字 + 匿名序号）。
 */

// 假 formatter：把 message id 和参数原样回显。断言于是读的是「走了哪条文案」，
// 而不是某个语言的具体译文——译文改字不该弄红这些测试。
function formatMessage({ id }: { id: string }, values?: Record<string, string | number>): string {
  if (values === undefined) return id;
  const args = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${id}(${args})`;
}

describe("laneDisplayName", () => {
  it("shows a script-authored actor name verbatim, never localized", () => {
    // 名字是脚本作者写下的文案，本地化它就是改作者的话。
    expect(laneDisplayName({ laneClass: "agent", name: "planner" }, formatMessage)).toBe("planner");
    // 有名字时序号无关：编号只是没名字时的区分手段。
    expect(
      laneDisplayName({ anonymousIndex: 2, laneClass: "agent", name: "planner" }, formatMessage),
    ).toBe("planner");
  });

  it("names a lone unnamed actor lane, instead of leaking its site id", () => {
    // 过去这里回退到 head.id，界面上就是一行「actor#3」——站点 id 是身份，不是名字。
    expect(laneDisplayName({ laneClass: "agent" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.anonymous",
    );
  });

  it("numbers unnamed actor lanes when the projection says several coexist", () => {
    expect(laneDisplayName({ anonymousIndex: 1, laneClass: "agent" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.anonymousIndexed(index=1)",
    );
    expect(laneDisplayName({ anonymousIndex: 2, laneClass: "agent" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.anonymousIndexed(index=2)",
    );
  });

  it("keeps the two synthetic lanes on their own localized labels", () => {
    // workspace 不是 actor（没有信箱），unresolved 是没能定位到站点的 ask：
    // 两者都不靠名字识别，文案固定。
    expect(laneDisplayName({ laneClass: "workspace" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.script",
    );
    expect(laneDisplayName({ laneClass: "unresolved" }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.unresolved",
    );
  });

  it("renders an interpolated name's static shape instead of the anonymous fallback", () => {
    // `` agent(`研究员${i + 1}`) `` 的形状仍然是作者的话，所以同样不本地化。
    expect(
      laneDisplayName({ laneClass: "agent", namePattern: { head: "研究员" } }, formatMessage),
    ).toBe("研究员…");
    expect(
      laneDisplayName({ laneClass: "agent", namePattern: { tail: "-worker" } }, formatMessage),
    ).toBe("…-worker");
    expect(
      laneDisplayName({ laneClass: "agent", namePattern: { head: "a", tail: "b" } }, formatMessage),
    ).toBe("a…b");
  });

  it("prefers a literal name over a pattern, and a pattern over the anonymous fallback", () => {
    // 优先级只有一条：精炼名 > 字面量名 > 形状 > 本地化兜底。带形状的车道**算有名字**，
    // 所以 anonymousIndex 就算在场也不该冒出来。
    expect(
      laneDisplayName(
        { laneClass: "agent", name: "planner", namePattern: { head: "研究员" } },
        formatMessage,
      ),
    ).toBe("planner");
    expect(
      laneDisplayName(
        { anonymousIndex: 2, laneClass: "agent", namePattern: { head: "研究员" } },
        formatMessage,
      ),
    ).toBe("研究员…");
  });

  it("shows the author's word over the interpolated shape", () => {
    // 三档顺位：作者原词 > 插值形状 > 匿名兜底。没有第四个来源——模型精炼那一档已撤回
    // （docs/dynamic-workflow/presentation.md）。
    expect(
      laneDisplayName(
        { laneClass: "agent", name: "planner", namePattern: { head: "研究员" } },
        formatMessage,
      ),
    ).toBe("planner");
  });

  it("falls back to anonymous rather than render a lone ellipsis", () => {
    // 分析器不发空 pattern，但协议上 `{}` 能过 `.strict()`；不兜住就会在车道头留一个
    // 什么也没说的省略号。
    expect(laneDisplayName({ laneClass: "agent", namePattern: {} }, formatMessage)).toBe(
      "chat.toolCall.workflow.graph.lane.anonymous",
    );
  });
});
