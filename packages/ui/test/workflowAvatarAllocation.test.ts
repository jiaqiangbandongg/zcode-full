import { describe, expect, it } from "vitest";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

describe("workflow avatar allocation", () => {
  it("同名代理不碰撞，同一代理跨阶段复用编号", () => {
    const lanes = Array.from({ length: 10 }, (_, i) => ({
      id: `actor#${i}`,
      name: "same name",
      line: i + 1,
      column: 1,
    }));
    const phases = ["a", "b"].map((id) => ({ id, name: id, line: 1 }));
    const steps = phases.flatMap((phase) =>
      lanes.map((lane) => ({
        id: `${phase.id}-${lane.id}`,
        kind: "ask" as const,
        label: "ask",
        line: 1,
        column: 1,
        lane: lane.id,
        phase: phase.id,
      })),
    );
    const graph: WorkflowCausalityGraphData = {
      lanes,
      phases,
      steps,
      participants: steps.map((step) => ({
        id: step.id,
        phase: step.phase,
        lane: step.lane,
        steps: [step.id],
      })),
      handoffs: [],
      phaseEdges: [{ from: "a", to: "b" }],
      exits: ["b"],
    };
    const stations = buildWorkflowTimeline(graph, undefined).stations;
    expect(stations[0]!.pills.map((p) => p.avatarIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(stations[1]!.pills.map((p) => p.avatarIndex)).toEqual(
      stations[0]!.pills.map((p) => p.avatarIndex),
    );
  });
});
