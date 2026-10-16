// 流式草稿扫描器（docs/dynamic-workflow/presentation.md「The draft and the pen」+ 追记「书写效果」）：模型还在
// 写脚本、分析器还没跑，卡上先把阶段线画出来。正则级扫描，认错了也无妨——display 一到整个模型被替换。
import { describe, expect, it } from "vitest";
import { draftTimeline, scanWorkflowDraft } from "@/components/workflow-timeline/draft-scan.js";

describe("scanWorkflowDraft", () => {
  it("phase 标记成站；子代理按出现顺序去重计数，不落在任何站下", () => {
    const draft = scanWorkflowDraft(`
      phase("plan");
      const planner = agent("planner");
      const scout = agent("scout");
      phase("draft");
      const writer = agent("writer");
      const again = agent("planner");
    `);
    expect(draft.phases).toEqual([{ name: "plan" }, { name: "draft" }]);
    expect(draft.agents).toEqual(["planner", "scout", "writer"]);
  });

  it("首个标记之前的声明只计数，不合成站；一个标记都没有时没有站", () => {
    const early = scanWorkflowDraft(`const a = agent("a"); phase("plan"); const b = agent("b");`);
    expect(early.phases).toEqual([{ name: "plan" }]);
    expect(early.agents).toEqual(["a", "b"]);

    const flat = scanWorkflowDraft(`const a = agent("a"); const b = agent('b');`);
    expect(flat.phases).toEqual([]);
    expect(flat.agents).toEqual(["a", "b"]);
  });

  it("同名的第二个 phase 是回到那一站（分析器折成回边），不是新站", () => {
    const draft = scanWorkflowDraft(
      `phase("plan"); phase("implement"); phase("verify"); if (!ok) { phase("implement"); } phase("ship");`,
    );
    expect(draft.phases.map((phase) => phase.name)).toEqual([
      "plan",
      "implement",
      "verify",
      "ship",
    ]);
  });

  it('未闭合的最后一个 phase("ver 是 typing 站；再次扫到同一处时定名而不是再开一站', () => {
    const typing = scanWorkflowDraft(`phase("plan"); phase("ver`);
    expect(typing.phases).toEqual([{ name: "plan" }, { name: "ver", typing: true }]);

    const closed = scanWorkflowDraft(`phase("plan"); phase("verify");`);
    expect(closed.phases).toEqual([{ name: "plan" }, { name: "verify" }]);
  });

  it('未闭合的 agent("wri 不计数：半个名字不算一个子代理', () => {
    const draft = scanWorkflowDraft(`phase("plan"); const w = agent("wri`);
    expect(draft.agents).toEqual([]);
  });

  it("模板字面量的插值只取头部", () => {
    const draft = scanWorkflowDraft(
      'phase("fan-out"); const a = agent(`researcher ${i}`); const b = agent(`researcher ${j}`); const c = agent("researcher");',
    );
    expect(draft.agents).toEqual(["researcher"]);
  });

  it("phase( 后面还没写引号时什么都不发生（既不开站也不崩）", () => {
    expect(scanWorkflowDraft(`phase(`).phases).toEqual([]);
    expect(scanWorkflowDraft(`phase("plan"); agent(`).phases).toEqual([{ name: "plan" }]);
  });
});

describe("draftTimeline", () => {
  it("只有站与淡墨轨道段：没有药丸、没有弧、没有状态、没有运行站；子代理只计数", () => {
    const model = draftTimeline(
      scanWorkflowDraft(
        `phase("plan"); const a = agent("a"); const b = agent("b"); await world.run("x"); phase("ver`,
      ),
    );
    expect(model.live).toBe(false);
    expect(model.draft).toEqual({ agents: 2 });
    expect(model.runningIndex).toBeUndefined();
    expect(model.arcs).toEqual([]);
    expect(model.rails).toEqual([{ from: 0, ink: "faint", to: 1 }]);
    expect(model.stations).toHaveLength(2);
    expect(model.stations[0]!.naming).toEqual({ id: "draft:0", name: "plan" });
    expect(model.stations[0]!.pills).toEqual([]);
    expect(model.stations.every((station) => station.status === undefined)).toBe(true);
    expect(model.stations[1]).toMatchObject({
      naming: { id: "draft:1", name: "ver" },
      pills: [],
      typing: true,
    });
  });
});
