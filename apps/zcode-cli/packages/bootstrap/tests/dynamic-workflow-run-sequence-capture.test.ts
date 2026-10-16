// 序号捕获层（引擎拿到的 journal）必须把读面选项原样转发（docs/execution-engine.md「Reading the
// journal」）：TS 允许实现的形参比签名少，写成固定选项照样编译通过，引擎的窄读就会悄悄退化回
// 整表读——这条测试钉住每一条读的选项都到达了真 store。
import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { createJournalSequenceCapture } from "../src/app/dynamic-workflow-run-sequence-capture.js";

function seeded(): InMemoryJournalStore {
  const store = new InMemoryJournalStore();
  store.createRun({ runId: "r", caps: { maxConcurrency: 4 }, spentTokens: 0, status: "running" });
  store.putActor({
    runId: "r",
    siteId: "actor#1",
    ordinal: 1,
    name: "a",
    persona: { system: "s" },
  });
  store.putActor({
    runId: "r",
    siteId: "actor#2",
    ordinal: 1,
    name: "b",
    persona: { system: "s" },
  });
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    store.putNode({
      runId: "r",
      siteId: "report#1",
      ordinal,
      kind: "report",
      inputHash: `h${ordinal}`,
      status: "completed",
      result: ordinal,
    });
    store.appendEvent("r", {
      type: "report",
      instance: { siteId: "report#1", ordinal },
      item: ordinal,
    });
  }
  store.putNode({
    runId: "r",
    siteId: "ask#1",
    ordinal: 1,
    kind: "ask",
    inputHash: "a",
    status: "completed",
    result: "x",
  });
  return store;
}

describe("createJournalSequenceCapture forwards read options", () => {
  it("passes kinds / withResult / limit / countNodes / types / reportItems / actor filters through", () => {
    const { journal } = createJournalSequenceCapture(seeded());
    const reports = journal.listNodes("r", { kinds: ["report"], withResult: false, limit: 2 });
    expect(reports.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(reports.every((row) => !("result" in row))).toBe(true);
    expect(journal.countNodes("r", "report")).toBe(3);
    expect(journal.getNode("r", "ask#1", 1, { withResult: false })).not.toHaveProperty("result");

    const events = journal.listEvents("r", { types: ["report"], reportItems: { limit: 1 } });
    expect(events.map((stored) => "item" in stored.event)).toEqual([true, false, false]);

    const actors = journal.listActors("r", { name: "b", withPersona: false });
    expect(actors.map((actor) => actor.siteId)).toEqual(["actor#2"]);
    expect(actors[0]).not.toHaveProperty("persona");
  });
});
