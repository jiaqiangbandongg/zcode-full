import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@zcode/contracts";
import {
  applyWorkflowGraphSeed,
  applyWorkflowNodePromptUpdates,
  cancelWorkflowSnapshot,
  reconcileWorkflowSnapshotForResume,
  reopenWorkflowGraphNode,
} from "../src/workflow/lifecycle.js";
import { DEFAULT_EXPERT_WORKFLOW_STRATEGY } from "../src/workflow/expert.js";

describe("workflow lifecycle repair", () => {
  it("resets stale active workflow state before resume", () => {
    const result = reconcileWorkflowSnapshotForResume(createSnapshot(), {
      timestamp: "2026-05-06T00:00:00.000Z",
    });

    expect(result.changed).toBe(true);
    expect(result.nodeChanges).toEqual([
      { nodeId: "phase:exec", phase: "exec", status: "pending" },
    ]);
    expect(result.phaseIds).toEqual(["exec"]);
    expect(result.activityIds).toEqual(["act-active"]);
    expect(result.snapshot.graph.nodes.find((node) => node.id === "phase:exec")).toMatchObject({
      error: expect.stringContaining("Reset during workflow resume"),
      status: "pending",
    });
    expect(result.snapshot.phases.find((phase) => phase.phase === "exec")).toMatchObject({
      error: expect.stringContaining("Reset during workflow resume"),
      status: "pending",
    });
    expect(
      result.snapshot.activities.find((activity) => activity.activityId === "act-active"),
    ).toMatchObject({
      completedAt: "2026-05-06T00:00:00.000Z",
      error: expect.stringContaining("Reset during workflow resume"),
      status: "cancelled",
    });
  });

  it("cancels all non-terminal workflow state for debugger accuracy", () => {
    const result = cancelWorkflowSnapshot(createSnapshot(), {
      timestamp: "2026-05-06T00:00:00.000Z",
    });

    expect(result.snapshot.status).toBe("cancelled");
    expect(result.snapshot.completedAt).toBe("2026-05-06T00:00:00.000Z");
    expect(result.snapshot.graph.nodes.map((node) => [node.id, node.status])).toEqual([
      ["phase:clarify", "completed"],
      ["phase:exec", "cancelled"],
      ["phase:final_critic", "cancelled"],
    ]);
    expect(result.snapshot.phases.map((phase) => [phase.phase, phase.status])).toEqual([
      ["clarify", "completed"],
      ["exec", "cancelled"],
      ["final_critic", "cancelled"],
    ]);
    expect(
      result.snapshot.activities.map((activity) => [activity.activityId, activity.status]),
    ).toEqual([
      ["act-done", "completed"],
      ["act-active", "cancelled"],
    ]);
  });

  it("reopens terminal graph nodes with a bounded attempt counter", () => {
    const snapshot = createSnapshot();
    const result = reopenWorkflowGraphNode(
      {
        ...snapshot,
        graph: {
          ...snapshot.graph,
          nodes: snapshot.graph.nodes.map((node) =>
            node.id === "phase:clarify"
              ? {
                  ...node,
                  reopenAttempts: 1,
                }
              : node,
          ),
        },
      },
      {
        maxReopens: 2,
        nodeId: "phase:clarify",
        reason: "regression detected",
        timestamp: "2026-05-06T00:00:00.000Z",
      },
    );

    expect(result.changed).toBe(true);
    expect(result.nodeChange).toEqual({
      nodeId: "phase:clarify",
      phase: "clarify",
      status: "pending",
    });
    expect(result.reopenAttempts).toBe(2);
    expect(result.snapshot.graph.nodes.find((node) => node.id === "phase:clarify")).toMatchObject({
      error: "regression detected",
      reopenAttempts: 2,
      status: "pending",
    });

    expect(() =>
      reopenWorkflowGraphNode(result.snapshot, {
        maxReopens: 2,
        nodeId: "phase:clarify",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
    ).toThrow('Cannot reopen workflow node "phase:clarify": status is "pending"');
  });

  it("rejects reopen attempts past the configured cap", () => {
    const snapshot = createSnapshot();
    expect(() =>
      reopenWorkflowGraphNode(
        {
          ...snapshot,
          graph: {
            ...snapshot.graph,
            nodes: snapshot.graph.nodes.map((node) =>
              node.id === "phase:clarify"
                ? {
                    ...node,
                    reopenAttempts: 2,
                  }
                : node,
            ),
          },
        },
        {
          maxReopens: 2,
          nodeId: "phase:clarify",
          timestamp: "2026-05-06T00:00:00.000Z",
        },
      ),
    ).toThrow('Workflow node "phase:clarify" already reopened 2x (max=2)');
  });

  it("applies workflow graph seeds with dependency edges and collections", () => {
    const result = applyWorkflowGraphSeed(
      createSnapshot(),
      {
        collections: [
          {
            collectionId: "implementation",
            nodeIds: ["implement_api", "validate_api"],
            phase: "exec",
          },
        ],
        edges: [],
        nodes: [
          {
            dependsOn: ["phase:exec"],
            id: "implement_api",
            phase: "exec",
            title: "Implement API",
          },
          {
            collectionId: "implementation",
            dependsOn: ["implement_api"],
            id: "validate_api",
            phase: "exec",
            title: "Validate API",
          },
        ],
      },
      {
        phase: "exec",
        timestamp: "2026-05-06T00:00:00.000Z",
      },
    );

    expect(result.changed).toBe(true);
    expect(result.addedNodes.map((node) => node.id)).toEqual(["implement_api", "validate_api"]);
    expect(result.addedEdges).toEqual([
      { from: "phase:exec", to: "implement_api" },
      { from: "implement_api", to: "validate_api" },
    ]);
    expect(result.addedCollections[0]).toMatchObject({
      collectionId: "implementation",
      nodeIds: ["implement_api", "validate_api"],
      phase: "exec",
    });
    expect(result.snapshot.graph.nodes.find((node) => node.id === "validate_api")).toMatchObject({
      kind: "task",
      status: "pending",
    });
  });

  it("rejects workflow graph seeds that would create cycles", () => {
    expect(() =>
      applyWorkflowGraphSeed(
        createSnapshot(),
        {
          edges: [
            { from: "phase:exec", to: "cycle_a" },
            { from: "cycle_a", to: "phase:exec" },
          ],
          nodes: [{ id: "cycle_a", title: "Cycle A" }],
        },
        {
          phase: "exec",
          timestamp: "2026-05-06T00:00:00.000Z",
        },
      ),
    ).toThrow("would create a cycle");
  });

  it("applies node prompt updates to existing target phase nodes", () => {
    const seeded = applyWorkflowGraphSeed(
      createSnapshot(),
      {
        nodes: [
          {
            dependsOn: ["phase:exec"],
            id: "implement_api",
            phase: "exec",
            title: "Implement API",
          },
        ],
      },
      {
        phase: "exec",
        timestamp: "2026-05-06T00:00:00.000Z",
      },
    ).snapshot;

    const result = applyWorkflowNodePromptUpdates(
      seeded,
      [
        {
          description: "Implement only the API boundary.",
          id: "implement_api",
          prompt: "Keep tests focused on the exported API behavior.",
          title: "Implement API boundary",
        },
      ],
      {
        phase: "exec",
        timestamp: "2026-05-06T00:01:00.000Z",
      },
    );

    expect(result.changed).toBe(true);
    expect(result.updatedNodes.map((node) => node.id)).toEqual(["implement_api"]);
    expect(result.snapshot.graph.nodes.find((node) => node.id === "implement_api")).toMatchObject({
      description: "Implement only the API boundary.",
      prompt: "Keep tests focused on the exported API behavior.",
      title: "Implement API boundary",
    });
  });

  it("rejects node prompt updates outside the target phase", () => {
    expect(() =>
      applyWorkflowNodePromptUpdates(
        createSnapshot(),
        [
          {
            id: "phase:clarify",
            prompt: "should not mutate clarify from exec",
          },
        ],
        {
          phase: "exec",
          timestamp: "2026-05-06T00:01:00.000Z",
        },
      ),
    ).toThrow('targets phase "exec" but node belongs to "clarify"');
  });
});

function createSnapshot(): WorkflowRunSnapshot {
  return {
    activities: [
      {
        activityId: "act-done",
        inputArtifactPaths: [],
        kind: "agent_session",
        nodeId: "phase:clarify",
        outputArtifactPaths: ["artifacts/01-clarify.md"],
        phase: "clarify",
        startedAt: "2026-05-05T00:00:00.000Z",
        status: "completed",
      },
      {
        activityId: "act-active",
        inputArtifactPaths: ["artifacts/01-clarify.md"],
        kind: "agent_session",
        nodeId: "phase:exec",
        outputArtifactPaths: [],
        phase: "exec",
        startedAt: "2026-05-05T00:01:00.000Z",
        status: "active",
      },
    ],
    artifacts: [],
    createdAt: "2026-05-05T00:00:00.000Z",
    currentPhase: "exec",
    cwd: "/repo",
    graph: {
      edges: [
        { from: "phase:clarify", to: "phase:exec" },
        { from: "phase:exec", to: "phase:final_critic" },
      ],
      nodes: [
        {
          dependsOn: [],
          id: "phase:clarify",
          kind: "phase",
          phase: "clarify",
          status: "completed",
          title: "Clarify",
        },
        {
          dependsOn: ["phase:clarify"],
          id: "phase:exec",
          kind: "phase",
          phase: "exec",
          status: "active",
          title: "Execute",
        },
        {
          dependsOn: ["phase:exec"],
          id: "phase:final_critic",
          kind: "phase",
          phase: "final_critic",
          status: "pending",
          title: "Final Critic",
        },
      ],
    },
    kind: "expert",
    phaseOrder: ["clarify", "exec", "final_critic"],
    phases: [
      { phase: "clarify", status: "completed" },
      {
        activityId: "act-active",
        phase: "exec",
        startedAt: "2026-05-05T00:01:00.000Z",
        status: "active",
      },
      { phase: "final_critic", status: "pending" },
    ],
    runId: "wf_lifecycle",
    schemaVersion: 1,
    status: "running",
    strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
    task: "ship lifecycle repair",
    updatedAt: "2026-05-05T00:01:00.000Z",
  };
}
