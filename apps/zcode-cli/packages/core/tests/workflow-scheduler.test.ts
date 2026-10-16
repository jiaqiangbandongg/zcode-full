import { describe, expect, it } from "vitest";
import {
  deriveWorkflowSchedulerState,
  type WorkflowEvent,
  type WorkflowGraph,
  type WorkflowGraphRecord,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import { WorkflowGraphScheduler } from "../src/workflow/scheduler.js";
import { DEFAULT_EXPERT_WORKFLOW_STRATEGY } from "../src/workflow/expert.js";

describe("WorkflowGraphScheduler", () => {
  it("derives ready and blocked nodes from graph dependencies", () => {
    const state = deriveWorkflowSchedulerState({
      edges: [{ from: "a", to: "b" }],
      nodes: [
        { dependsOn: [], id: "a", kind: "task", status: "completed", title: "A" },
        { dependsOn: ["a"], id: "b", kind: "task", status: "pending", title: "B" },
        { dependsOn: ["missing"], id: "c", kind: "task", status: "pending", title: "C" },
      ],
    });

    expect(state.readyNodeIds).toEqual(["b"]);
    expect(state.blockedNodes).toEqual([{ blockedBy: ["missing"], nodeId: "c" }]);
    expect(state.counts).toMatchObject({
      blocked: 1,
      completed: 1,
      pending: 2,
      ready: 1,
      total: 3,
    });
  });

  it("dispatches independent ready nodes concurrently and waits for dependencies", async () => {
    const events: WorkflowEvent[] = [];
    const graphRecords: WorkflowGraphRecord[] = [];
    const started: string[] = [];
    const completed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let now = 0;
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async (event) => {
        events.push(event);
      },
      appendGraphRecord: async (_runId, record) => {
        graphRecords.push(record);
      },
      createActivityId: () => `act_${events.length}_${started.length}`,
      now: () => new Date(1_700_000_000_000 + now++),
      runner: {
        run: async ({ node }) => {
          started.push(node.id);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, node.id === "c" ? 1 : 10));
          inFlight--;
          completed.push(node.id);
          return {
            response: `# ${node.id}`,
            sessionId: `sess_${node.id}`,
          };
        },
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["a", "b", "c"],
      phase: "exec",
      snapshot: createSnapshot({
        edges: [
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
        nodes: [
          { dependsOn: [], id: "a", kind: "task", status: "pending", title: "A" },
          { dependsOn: [], id: "b", kind: "task", status: "pending", title: "B" },
          { dependsOn: ["a", "b"], id: "c", kind: "task", status: "pending", title: "C" },
        ],
      }),
    });

    expect(result.status).toBe("completed");
    expect(maxInFlight).toBe(2);
    expect(started.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(started.at(-1)).toBe("c");
    expect(completed.sort()).toEqual(["a", "b", "c"]);
    expect(result.snapshot.graph.nodes.map((node) => [node.id, node.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "frontier_changed",
        "node_started",
        "node_completed",
        "executor_completed",
      ]),
    );
    expect(
      graphRecords.some(
        (record) =>
          record.recordType === "op" && record.nodeId === "c" && record.status === "completed",
      ),
    ).toBe(true);
  });

  it("retries failed nodes and pauses at the consecutive error threshold", async () => {
    const events: WorkflowEvent[] = [];
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async (event) => {
        events.push(event);
      },
      appendGraphRecord: async () => {},
      createActivityId: () => `act_${events.length}`,
      now: () => new Date("2026-05-05T00:00:00Z"),
      runner: {
        run: async () => {
          throw new Error("node failed");
        },
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["flaky"],
      phase: "exec",
      snapshot: createSnapshot(
        {
          edges: [],
          nodes: [
            {
              dependsOn: [],
              id: "flaky",
              kind: "task",
              status: "pending",
              title: "Flaky",
            },
          ],
        },
        { maxConsecutiveErrors: 2 },
      ),
    });

    expect(result.status).toBe("paused");
    expect(result.reason).toBe("error_threshold");
    expect(result.snapshot.graph.nodes[0]).toMatchObject({
      attempts: 2,
      error: "node failed",
      status: "failed",
    });
    expect(events.filter((event) => event.type === "node_failed")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "executor_paused",
    });
  });

  it("runs collection planners, expands the graph, and schedules new nodes", async () => {
    const events: WorkflowEvent[] = [];
    const graphRecords: WorkflowGraphRecord[] = [];
    const started: string[] = [];
    const plannerCollections: string[] = [];
    let now = 0;
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async (event) => {
        events.push(event);
      },
      appendGraphRecord: async (_runId, record) => {
        graphRecords.push(record);
      },
      createActivityId: () => `act_${events.length}_${started.length}_${plannerCollections.length}`,
      now: () => new Date(1_700_000_000_000 + now++),
      plannerRunner: {
        run: async ({ collection }) => {
          plannerCollections.push(collection.collectionId);
          if (plannerCollections.length === 1) {
            return {
              edges: [{ from: "seed", to: "follow_up" }],
              nodes: [
                {
                  dependsOn: ["seed"],
                  id: "follow_up",
                  title: "Follow Up",
                },
              ],
              response:
                '{"nodes":[{"id":"follow_up","title":"Follow Up","dependsOn":["seed"]}],"edges":[{"from":"seed","to":"follow_up"}]}',
              sessionId: "planner-one",
            };
          }
          return {
            edges: [],
            exhausted: true,
            nodes: [],
            response: '{"nodes":[],"edges":[],"exhausted":true}',
            sessionId: "planner-two",
          };
        },
      },
      runner: {
        run: async ({ node }) => {
          started.push(node.id);
          return {
            response: `# ${node.id}`,
            sessionId: `sess_${node.id}`,
          };
        },
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["seed"],
      phase: "exec",
      snapshot: createSnapshot(
        {
          collections: [
            {
              collectionId: "research",
              explorable: true,
              frontierTarget: 1,
              nodeIds: ["seed"],
            },
          ],
          edges: [],
          nodes: [
            {
              collectionId: "research",
              dependsOn: [],
              id: "seed",
              kind: "task",
              status: "completed",
              title: "Seed",
            },
          ],
        },
        { maxPlannerRuns: 3 },
      ),
    });

    expect(result.status).toBe("completed");
    expect(plannerCollections).toEqual(["research", "research"]);
    expect(started).toEqual(["follow_up"]);
    expect(result.snapshot.graph.nodes.map((node) => [node.id, node.status])).toEqual([
      ["seed", "completed"],
      ["follow_up", "completed"],
    ]);
    expect(result.snapshot.graph.collections?.[0]).toMatchObject({
      analyzedNodeIds: ["seed", "follow_up"],
      collectionId: "research",
      exhausted: true,
      nodeIds: ["seed", "follow_up"],
      plannerRuns: 2,
      status: "exhausted",
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "planner_started",
        "planner_completed",
        "graph_expanded",
        "node_completed",
        "collection_exhausted",
      ]),
    );
    expect(
      graphRecords.some(
        (record) =>
          record.recordType === "op" &&
          record.type === "graph_expanded" &&
          record.collectionId === "research",
      ),
    ).toBe(true);
  });

  it("does not run a collection planner before seeded frontier has a completion", async () => {
    const plannerCalls: string[] = [];
    const started: string[] = [];
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async () => {},
      appendGraphRecord: async () => {},
      createActivityId: () => `act_${plannerCalls.length}_${started.length}`,
      now: () => new Date("2026-05-05T00:00:00Z"),
      plannerRunner: {
        run: async ({ collection }) => {
          plannerCalls.push(collection.collectionId);
          return {
            edges: [],
            exhausted: true,
            nodes: [],
            response: '{"nodes":[],"edges":[],"exhausted":true}',
            sessionId: "planner",
          };
        },
      },
      runner: {
        run: async ({ node }) => {
          expect(plannerCalls).toEqual([]);
          started.push(node.id);
          return {
            response: `# ${node.id}`,
            sessionId: `sess_${node.id}`,
          };
        },
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["seed"],
      phase: "exec",
      snapshot: createSnapshot({
        collections: [
          {
            collectionId: "research",
            explorable: true,
            frontierTarget: 2,
            nodeIds: ["seed"],
          },
        ],
        edges: [],
        nodes: [
          {
            collectionId: "research",
            dependsOn: [],
            id: "seed",
            kind: "task",
            status: "pending",
            title: "Seed",
          },
        ],
      }),
    });

    expect(result.status).toBe("completed");
    expect(started).toEqual(["seed"]);
    expect(plannerCalls).toEqual(["research"]);
  });

  it("exhausts a collection instead of running past maxPlannerRuns", async () => {
    const events: WorkflowEvent[] = [];
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async (event) => {
        events.push(event);
      },
      appendGraphRecord: async () => {},
      createActivityId: () => `act_${events.length}`,
      now: () => new Date("2026-05-05T00:00:00Z"),
      plannerRunner: {
        run: async () => {
          throw new Error("planner should not run");
        },
      },
      runner: {
        run: async ({ node }) => ({
          response: `# ${node.id}`,
          sessionId: `sess_${node.id}`,
        }),
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["seed"],
      phase: "exec",
      snapshot: createSnapshot(
        {
          collections: [
            {
              collectionId: "research",
              explorable: true,
              nodeIds: ["seed"],
              plannerRuns: 1,
            },
          ],
          edges: [],
          nodes: [
            {
              collectionId: "research",
              dependsOn: [],
              id: "seed",
              kind: "task",
              status: "completed",
              title: "Seed",
            },
          ],
        },
        { maxPlannerRuns: 1 },
      ),
    });

    expect(result.status).toBe("completed");
    expect(result.snapshot.graph.collections?.[0]).toMatchObject({
      collectionId: "research",
      exhausted: true,
      status: "exhausted",
    });
    expect(events.at(0)).toMatchObject({
      payload: {
        reason: "max_planner_runs",
      },
      type: "collection_exhausted",
    });
  });

  it("records planner failures without corrupting graph state", async () => {
    const events: WorkflowEvent[] = [];
    const scheduler = new WorkflowGraphScheduler({
      appendEvent: async (event) => {
        events.push(event);
      },
      appendGraphRecord: async () => {},
      createActivityId: () => `act_${events.length}`,
      now: () => new Date("2026-05-05T00:00:00Z"),
      plannerRunner: {
        run: async () => {
          throw new Error("planner failed");
        },
      },
      runner: {
        run: async ({ node }) => ({
          response: `# ${node.id}`,
          sessionId: `sess_${node.id}`,
        }),
      },
      writeArtifact: async (_runId, relativePath) => ({
        path: relativePath,
        relativePath,
      }),
      writeSnapshot: async () => {},
    });

    const result = await scheduler.run({
      cwd: "/repo",
      executableNodeIds: ["seed"],
      phase: "exec",
      snapshot: createSnapshot(
        {
          collections: [
            {
              collectionId: "research",
              explorable: true,
              nodeIds: ["seed"],
            },
          ],
          edges: [],
          nodes: [
            {
              collectionId: "research",
              dependsOn: [],
              id: "seed",
              kind: "task",
              status: "completed",
              title: "Seed",
            },
          ],
        },
        { maxConsecutiveErrors: 1 },
      ),
    });

    expect(result.status).toBe("completed");
    expect(result.snapshot.graph.nodes).toEqual([
      {
        collectionId: "research",
        dependsOn: [],
        id: "seed",
        kind: "task",
        status: "completed",
        title: "Seed",
      },
    ]);
    expect(result.snapshot.graph.collections?.[0]).toMatchObject({
      collectionId: "research",
      errorCount: 1,
      exhausted: true,
      status: "exhausted",
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["planner_failed", "collection_exhausted"]),
    );
  });
});

function createSnapshot(
  graph: WorkflowGraph,
  options: { maxConsecutiveErrors?: number; maxPlannerRuns?: number } = {},
): WorkflowRunSnapshot {
  return {
    activities: [],
    artifacts: [],
    createdAt: "2026-05-05T00:00:00.000Z",
    cwd: "/repo",
    graph,
    kind: "expert",
    phaseOrder: ["exec"],
    phases: [{ phase: "exec", status: "pending" }],
    runId: "wf_scheduler_test",
    schemaVersion: 1,
    status: "running",
    strategy: {
      ...DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      executor: {
        ...DEFAULT_EXPERT_WORKFLOW_STRATEGY.executor,
        maxConsecutiveErrors:
          options.maxConsecutiveErrors ??
          DEFAULT_EXPERT_WORKFLOW_STRATEGY.executor.maxConsecutiveErrors,
        maxPlannerRuns:
          options.maxPlannerRuns ?? DEFAULT_EXPERT_WORKFLOW_STRATEGY.executor.maxPlannerRuns,
      },
    },
    task: "ship workflow scheduler",
    updatedAt: "2026-05-05T00:00:00.000Z",
  };
}
