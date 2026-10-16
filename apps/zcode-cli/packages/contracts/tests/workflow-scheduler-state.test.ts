import { describe, expect, it } from "vitest";
import {
  ExpertWorkflowRunSnapshotSchema,
  WorkflowAgentCallInputSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSnapshotSchema,
  WorkflowSchedulerStateSchema,
  WorkflowScriptMetaSchema,
  WorkflowStrategySchema,
  deriveWorkflowRunSchedulerState,
  deriveWorkflowSchedulerState,
  deriveWorkflowSessionLinks,
} from "../src/workflow/index.js";
import {
  WorkflowInputJsonSchema,
  WorkflowInputSchema,
  WorkflowOutputSchema,
} from "../src/tools/workflow.js";

describe("deriveWorkflowSchedulerState", () => {
  it("validates script workflow meta and agent call options", () => {
    const meta = WorkflowScriptMetaSchema.parse({
      description: "Review changed files",
      name: "review-changes",
      phases: [
        { title: "Review", detail: "Find candidate issues" },
        { title: "Verify", model: "lite" },
      ],
      whenToUse: "Use for code review.",
    });
    expect(meta.phases.map((phase) => phase.title)).toEqual(["Review", "Verify"]);
    expect(() =>
      WorkflowScriptMetaSchema.parse({
        description: "bad duplicate phases",
        name: "bad",
        phases: [{ title: "Review" }, { title: "Review" }],
      }),
    ).toThrow("Duplicate workflow phase title");

    const call = WorkflowAgentCallInputSchema.parse({
      opts: {
        agentType: "Reviewer",
        instructions: "Return raw findings.",
        isolation: "worktree",
        label: "review:diff",
        maxTurns: 8,
        model: "main",
        phase: "Review",
        schema: { type: "object" },
        skills: ["react"],
        systemPrompt: "Trusted workflows may set this through policy.",
        timeoutMs: 60_000,
        tools: ["Read"],
      },
      prompt: "Review current diff.",
    });
    expect(call.opts?.label).toBe("review:diff");
  });

  it("validates the model-facing Workflow tool schema", () => {
    expect(WorkflowInputSchema.parse({ script: "export const meta = {}" }).script).toContain(
      "meta",
    );
    expect(WorkflowInputSchema.parse({ name: "review", args: { target: "src" } }).name).toBe(
      "review",
    );
    expect(
      WorkflowInputSchema.parse({ scriptPath: ".zcode/workflows/review.workflow.js" }),
    ).toMatchObject({
      scriptPath: ".zcode/workflows/review.workflow.js",
    });
    expect(WorkflowInputSchema.parse({ resumeFromRunId: "wf_abc123" }).resumeFromRunId).toBe(
      "wf_abc123",
    );
    expect(() => WorkflowInputSchema.parse({})).toThrow("Workflow requires");
    expect(() => WorkflowInputSchema.parse({ resumeFromRunId: "workflow_old" })).toThrow();
    expect(
      (WorkflowInputJsonSchema.properties as Record<string, unknown>).scriptPath,
    ).toBeDefined();
    expect(
      WorkflowOutputSchema.parse({
        backgroundTaskId: "wf_abc123",
        response: "started",
        runId: "wf_abc123",
        status: "backgrounded",
        traceId: "trace",
      }).status,
    ).toBe("backgrounded");
  });

  it("validates workflow definitions with phase order and behavior metadata", () => {
    const definition = WorkflowDefinitionSchema.parse({
      definitionId: "audit",
      definitionVersion: "1",
      kind: "audit",
      phaseOrder: ["inspect", "fix", "complete"],
      phases: [
        {
          description: "Inspect the workspace.",
          phase: "inspect",
          title: "Inspect",
        },
        {
          behavior: "scheduled_graph",
          description: "Run graph nodes.",
          phase: "fix",
          title: "Fix",
        },
        {
          behavior: "complete",
          description: "Write the report.",
          phase: "complete",
          title: "Complete",
        },
      ],
      strategy: createStrategy(),
      title: "Audit Workflow",
    });

    expect(definition.phases.map((phase) => phase.behavior)).toEqual([
      "agent",
      "scheduled_graph",
      "complete",
    ]);
    expect(definition.definitionId).toBe("audit");
    expect(definition.definitionVersion).toBe("1");
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...definition,
        phaseOrder: ["inspect", "missing", "complete"],
      }),
    ).toThrow("unknown phase");
  });

  it("derives ready and blocked workflow graph nodes from dependencies", () => {
    const state = deriveWorkflowSchedulerState({
      edges: [{ from: "plan", to: "exec" }],
      nodes: [
        { dependsOn: [], id: "plan", kind: "phase", status: "completed", title: "Plan" },
        { dependsOn: ["plan"], id: "exec", kind: "phase", status: "pending", title: "Exec" },
        {
          dependsOn: ["missing"],
          id: "critic",
          kind: "phase",
          status: "pending",
          title: "Critic",
        },
      ],
    });

    expect(state.readyNodeIds).toEqual(["exec"]);
    expect(state.blockedNodes).toEqual([{ blockedBy: ["missing"], nodeId: "critic" }]);
    expect(state.counts).toMatchObject({
      blocked: 1,
      completed: 1,
      pending: 2,
      ready: 1,
      total: 3,
    });
    expect(WorkflowSchedulerStateSchema.parse(state).readyNodeIds).toEqual(["exec"]);
  });

  it("derives collection frontier and ready state", () => {
    const state = deriveWorkflowSchedulerState({
      collections: [
        {
          collectionId: "research",
          explorable: true,
          frontierTarget: 2,
          nodeIds: ["scan", "verify"],
          plannerRuns: 1,
        },
      ],
      edges: [{ from: "scan", to: "verify" }],
      nodes: [
        {
          collectionId: "research",
          dependsOn: [],
          id: "scan",
          kind: "task",
          status: "completed",
          title: "Scan",
        },
        {
          collectionId: "research",
          dependsOn: ["scan"],
          id: "verify",
          kind: "task",
          status: "pending",
          title: "Verify",
        },
      ],
    });

    expect(state.readyNodeIds).toEqual(["verify"]);
    expect(state.collectionStates).toEqual([
      expect.objectContaining({
        frontier: 1,
        frontierTarget: 2,
        plannerRuns: 1,
        readyNodeIds: ["verify"],
      }),
    ]);
    expect(state.nodes.find((entry) => entry.node.id === "verify")?.collectionIds).toEqual([
      "research",
    ]);
  });

  it("keeps workflow run contracts generic while preserving the expert alias", () => {
    const strategy = createStrategy();
    const snapshot = {
      activities: [],
      artifacts: [],
      createdAt: "2026-05-06T00:00:00.000Z",
      cwd: "/repo",
      graph: {
        edges: [],
        nodes: [{ dependsOn: [], id: "scan", kind: "task", status: "pending", title: "Scan" }],
      },
      kind: "audit",
      phaseOrder: ["scan"],
      phases: [{ phase: "scan", status: "pending" }],
      runId: "wf_audit_test",
      schemaVersion: 1,
      status: "running",
      strategy,
      task: "audit workflow contract",
      updatedAt: "2026-05-06T00:00:01.000Z",
    };

    expect(WorkflowRunSnapshotSchema.parse(snapshot).kind).toBe("audit");
    expect(ExpertWorkflowRunSnapshotSchema.parse(snapshot).kind).toBe("audit");
  });

  it("derives active child sessions from workflow run activities", () => {
    const snapshot = WorkflowRunSnapshotSchema.parse({
      activities: [
        {
          activityId: "act-running",
          inputArtifactPaths: [],
          kind: "agent_session",
          nodeId: "task:scan",
          outputArtifactPaths: [],
          phase: "exec",
          sessionId: "sess-child",
          startedAt: "2026-05-06T00:00:00.000Z",
          status: "active",
          traceId: "trace-child",
        },
      ],
      artifacts: [],
      createdAt: "2026-05-06T00:00:00.000Z",
      cwd: "/repo",
      graph: {
        edges: [],
        nodes: [
          {
            dependsOn: [],
            id: "task:scan",
            kind: "task",
            status: "active",
            title: "Scan",
          },
        ],
      },
      kind: "audit",
      phaseOrder: ["exec"],
      phases: [{ phase: "exec", status: "active" }],
      runId: "wf_scheduler_detail",
      schemaVersion: 1,
      status: "running",
      strategy: createStrategy(),
      task: "audit workflow state",
      updatedAt: "2026-05-06T00:00:01.000Z",
    });

    const state = deriveWorkflowRunSchedulerState(snapshot);

    expect(state.activeChildSessionIds).toEqual(["sess-child"]);
    expect(state.activeActivities).toEqual([
      {
        activityId: "act-running",
        nodeId: "task:scan",
        phase: "exec",
        sessionId: "sess-child",
        traceId: "trace-child",
      },
    ]);
    expect(WorkflowSchedulerStateSchema.parse(state).activeChildSessionIds).toEqual(["sess-child"]);
  });

  it("derives workflow session links from activity attempts", () => {
    const snapshot = WorkflowRunSnapshotSchema.parse({
      activities: [
        {
          activityId: "act-1",
          completedAt: "2026-05-06T00:00:02.000Z",
          inputArtifactPaths: [],
          kind: "agent_session",
          model: "zai/glm-main",
          nodeId: "task:scan",
          outputArtifactPaths: [],
          phase: "exec",
          sessionId: "sess-1",
          startedAt: "2026-05-06T00:00:00.000Z",
          status: "failed",
        },
        {
          activityId: "act-2",
          completedAt: "2026-05-06T00:00:04.000Z",
          inputArtifactPaths: [],
          kind: "agent_session",
          model: "deepseek/deepseek-v4-pro",
          nodeId: "task:scan",
          outputArtifactPaths: [],
          phase: "exec",
          sessionId: "sess-2",
          startedAt: "2026-05-06T00:00:03.000Z",
          status: "completed",
        },
      ],
      artifacts: [],
      createdAt: "2026-05-06T00:00:00.000Z",
      cwd: "/repo",
      graph: {
        edges: [],
        nodes: [
          {
            dependsOn: [],
            id: "task:scan",
            kind: "task",
            status: "completed",
            title: "Scan",
          },
        ],
      },
      kind: "audit",
      phaseOrder: ["exec"],
      phases: [{ phase: "exec", status: "completed" }],
      runId: "wf_links",
      schemaVersion: 1,
      status: "paused",
      strategy: createStrategy(),
      task: "audit workflow links",
      updatedAt: "2026-05-06T00:00:04.000Z",
    });

    expect(snapshot.sessionLinks).toEqual([]);
    expect(deriveWorkflowSessionLinks(snapshot)).toEqual([
      expect.objectContaining({
        activityId: "act-1",
        attempt: 1,
        model: "zai/glm-main",
        sessionId: "sess-1",
        status: "failed",
      }),
      expect.objectContaining({
        activityId: "act-2",
        attempt: 2,
        model: "deepseek/deepseek-v4-pro",
        sessionId: "sess-2",
        status: "completed",
      }),
    ]);
  });

  it("derives collection frontier state for ACP workflow debugging", () => {
    const state = deriveWorkflowSchedulerState({
      collections: [
        {
          collectionId: "research",
          explorable: true,
          frontierTarget: 2,
          nodeIds: ["scan", "inspect"],
          plannerRuns: 1,
        },
      ],
      edges: [{ from: "scan", to: "inspect" }],
      nodes: [
        {
          collectionId: "research",
          dependsOn: [],
          id: "scan",
          kind: "task",
          status: "completed",
          title: "Scan",
        },
        {
          collectionId: "research",
          dependsOn: ["scan"],
          id: "inspect",
          kind: "task",
          status: "pending",
          title: "Inspect",
        },
      ],
    });

    expect(state.collectionStates).toEqual([
      expect.objectContaining({
        activeNodeIds: [],
        completedNodeIds: ["scan"],
        frontier: 1,
        frontierTarget: 2,
        pendingNodeIds: ["inspect"],
        plannerRuns: 1,
        readyNodeIds: ["inspect"],
        status: "active",
      }),
    ]);
    expect(state.nodes.find((node) => node.node.id === "inspect")?.collectionIds).toEqual([
      "research",
    ]);
    expect(WorkflowSchedulerStateSchema.parse(state).collectionStates).toHaveLength(1);
  });
});

function createStrategy() {
  return WorkflowStrategySchema.parse({
    clarify: { confidenceThreshold: 0.8, maxRounds: 3, minRounds: 1 },
    executor: {
      drainingChangeHours: 1,
      frontierTarget: 3,
      maxConcurrentLoops: 2,
      maxConsecutiveErrors: 3,
      maxPlannerRuns: 10,
    },
    finalCritic: { maxIterations: 3 },
    reactLoop: { maxRounds: 30 },
  });
}
