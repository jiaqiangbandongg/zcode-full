import { describe, expect, it } from "vitest";
import type {
  ExpertWorkflowRunSnapshot,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowGraphRecord,
  WorkflowRunListItem,
  WorkflowStorePort,
} from "@zcode/contracts";
import { ExpertWorkflowRuntime, DEFAULT_EXPERT_WORKFLOW_STRATEGY } from "../src/workflow/expert.js";

class MemoryWorkflowStore implements WorkflowStorePort {
  artifacts = new Map<string, string>();
  events: WorkflowEvent[] = [];
  graphRecords: WorkflowGraphRecord[] = [];
  snapshots = new Map<string, ExpertWorkflowRunSnapshot>();

  async appendEvent(event: WorkflowEvent): Promise<void> {
    this.events.push(event);
  }

  async appendGraphRecord(_runId: string, record: WorkflowGraphRecord): Promise<void> {
    this.graphRecords.push(record);
  }

  async listRuns(): Promise<WorkflowRunListItem[]> {
    return [...this.snapshots.values()]
      .map((snapshot) => ({
        completedAt: snapshot.completedAt,
        createdAt: snapshot.createdAt,
        cwd: snapshot.cwd,
        kind: snapshot.kind,
        runId: snapshot.runId,
        status: snapshot.status,
        task: snapshot.task,
        updatedAt: snapshot.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readEvents(runId: string): Promise<WorkflowEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async readLatestRun(): Promise<ExpertWorkflowRunSnapshot | null> {
    const [latest] = await this.listRuns();
    return latest ? (this.snapshots.get(latest.runId) ?? null) : null;
  }

  async readRun(runId: string): Promise<ExpertWorkflowRunSnapshot | null> {
    return this.snapshots.get(runId) ?? null;
  }

  async writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
  ): Promise<{ path: string; relativePath: string }> {
    const key = `${runId}/${relativePath}`;
    this.artifacts.set(key, content);
    return {
      path: key,
      relativePath,
    };
  }

  async writeReport(
    runId: string,
    content: string,
  ): Promise<{ path: string; relativePath: string }> {
    return this.writeArtifact(runId, "report.md", content);
  }

  async writeSnapshot(snapshot: ExpertWorkflowRunSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, snapshot);
  }
}

describe("ExpertWorkflowRuntime", () => {
  it("runs the GSAP-inspired phase schedule and writes artifacts", async () => {
    const store = new MemoryWorkflowStore();
    const phases: string[] = [];
    let now = 0;
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          phases.push(input.phase);
          if (input.phase === "final_critic") {
            return {
              response: JSON.stringify({
                reasoning: "looks good",
                verdict: "pass",
              }),
              sessionId: `sess-${input.phase}`,
              traceId: `trace-${input.phase}`,
              turnId: `turn-${input.phase}`,
            };
          }
          return {
            response: `# ${input.phase}\n\nok`,
            sessionId: `sess-${input.phase}`,
            traceId: `trace-${input.phase}`,
            turnId: `turn-${input.phase}`,
          };
        },
      },
      createRunId: () => "wf_expert_test",
      now: () => new Date(1_700_000_000_000 + now++),
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "implement login",
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toBe("wf_expert_test");
    expect(phases).toEqual([
      "clarify",
      "task_analysis",
      "arch_decompose",
      "env_setup",
      "meta_prompt",
      "exec",
      "final_critic",
    ]);
    expect(result.snapshot?.definitionId).toBe("expert");
    expect(result.snapshot?.definitionVersion).toBe("2");
    expect(result.snapshot?.strategy).toEqual(DEFAULT_EXPERT_WORKFLOW_STRATEGY);
    expect(result.snapshot?.phases.every((phase) => phase.status === "completed")).toBe(true);
    expect(result.snapshot?.activities).toHaveLength(7);
    expect(result.snapshot?.activities.map((activity) => activity.sessionId)).toEqual([
      "sess-clarify",
      "sess-task_analysis",
      "sess-arch_decompose",
      "sess-env_setup",
      "sess-meta_prompt",
      "sess-exec",
      "sess-final_critic",
    ]);
    expect(store.artifacts.has("wf_expert_test/artifacts/01-clarify.md")).toBe(true);
    expect(store.artifacts.has("wf_expert_test/artifacts/06-exec.md")).toBe(true);
    expect(store.artifacts.has("wf_expert_test/report.md")).toBe(true);
    expect(store.events.map((event) => event.type)).toContain("run_completed");
    expect(store.events.map((event) => event.type)).toContain("node_started");
    expect(store.events.map((event) => event.type)).toContain("executor_completed");
    expect(store.events.map((event) => event.type)).toContain("critic_passed");
    expect(store.graphRecords.some((record) => record.recordType === "meta")).toBe(true);
    expect(
      store.graphRecords.some(
        (record) =>
          record.recordType === "meta" &&
          record.definitionId === "expert" &&
          record.definitionVersion === "2",
      ),
    ).toBe(true);
    expect(
      store.graphRecords.some(
        (record) =>
          record.recordType === "op" && record.phase === "exec" && record.status === "completed",
      ),
    ).toBe(true);
  });

  it("runs from a generic workflow definition instead of hardcoded expert phases", async () => {
    const store = new MemoryWorkflowStore();
    const phases: string[] = [];
    const definition: WorkflowDefinition = {
      definitionId: "audit",
      definitionVersion: "1",
      description: "Small custom workflow used to verify definition-driven dispatch.",
      kind: "audit",
      phaseOrder: ["inspect", "fix", "verify", "complete"],
      phases: [
        {
          behavior: "agent",
          description: "Inspect the target.",
          phase: "inspect",
          title: "Inspect",
        },
        {
          artifactPath: "artifacts/fix.md",
          behavior: "scheduled_graph",
          description: "Apply the fix through the graph scheduler.",
          phase: "fix",
          title: "Fix",
        },
        {
          behavior: "critic",
          description: "Verify the fixed graph.",
          phase: "verify",
          title: "Verify",
        },
        {
          behavior: "complete",
          description: "Write the report.",
          phase: "complete",
          title: "Complete",
        },
      ],
      strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      title: "Audit Workflow",
    };
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          phases.push(input.phase);
          return {
            response:
              input.phase === "verify"
                ? JSON.stringify({ reasoning: "custom workflow passed", verdict: "pass" })
                : `# ${input.phase}\n\nok`,
            sessionId: `sess-${input.phase}`,
          };
        },
      },
      createRunId: () => "wf_audit_test",
      definition,
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "audit configuration",
    });

    expect(result.status).toBe("completed");
    expect(result.snapshot?.kind).toBe("audit");
    expect(result.snapshot?.definitionId).toBe("audit");
    expect(result.snapshot?.definitionVersion).toBe("1");
    expect(result.snapshot?.phaseOrder).toEqual(["inspect", "fix", "verify", "complete"]);
    expect(phases).toEqual(["inspect", "fix", "verify"]);
    expect(store.events.every((event) => event.kind === "audit")).toBe(true);
    expect(store.artifacts.has("wf_audit_test/artifacts/fix.md")).toBe(true);
  });

  it("seeds scheduled exec nodes from a legacy architecture graph artifact", async () => {
    const store = new MemoryWorkflowStore();
    const phases: string[] = [];
    const execNodeIds: string[] = [];
    let now = 0;
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          phases.push(input.phase);
          if (input.phase === "arch_decompose") {
            return {
              response: [
                "```json",
                JSON.stringify({
                  collections: [
                    {
                      explorable: false,
                      goal: "Ship the API change",
                      metric: "Unit tests pass",
                      name: "implementation",
                      nodeNames: ["implement_api", "validate_api"],
                    },
                  ],
                  edges: [
                    {
                      interaction: "must_complete_before",
                      source: "implement_api",
                      target: "validate_api",
                      type: "edge",
                    },
                  ],
                  nodes: [
                    {
                      description: "Implement the API behavior.",
                      name: "implement_api",
                      prompt: "Update only the API boundary and keep validation scoped.",
                      references: [],
                      type: "node",
                    },
                    {
                      description: "Validate the API behavior.",
                      name: "validate_api",
                      references: ["implement_api"],
                      type: "node",
                    },
                  ],
                }),
                "```",
              ].join("\n"),
              sessionId: "sess-arch",
            };
          }
          if (input.phase === "exec") {
            const match = input.prompt.match(/Node id: ([^\n]+)/);
            execNodeIds.push(match?.[1] ?? "missing");
            if (match?.[1] === "implement_api") {
              expect(input.prompt).toContain(
                "Update only the API boundary and keep validation scoped.",
              );
            }
          }
          if (input.phase === "final_critic") {
            return {
              response: JSON.stringify({
                reasoning: "seeded graph passed",
                verdict: "pass",
              }),
              sessionId: "sess-final",
            };
          }
          return {
            response: `# ${input.phase}\n\nok`,
            sessionId: `sess-${input.phase}`,
          };
        },
      },
      createRunId: () => "wf_seeded_exec",
      now: () => new Date(1_700_000_000_000 + now++),
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "ship seeded exec graph",
    });

    expect(result.status).toBe("completed");
    expect(execNodeIds).toEqual(["implement_api", "validate_api"]);
    expect(phases.filter((phase) => phase === "exec")).toHaveLength(2);
    expect(result.snapshot?.graph.nodes.find((node) => node.id === "phase:exec")).toMatchObject({
      status: "completed",
    });
    expect(result.snapshot?.graph.nodes.find((node) => node.id === "implement_api")).toMatchObject({
      kind: "task",
      phase: "exec",
      status: "completed",
    });
    expect(result.snapshot?.graph.collections?.[0]).toMatchObject({
      collectionId: "implementation",
      nodeIds: ["implement_api", "validate_api"],
      phase: "exec",
    });
    expect(
      result.snapshot?.activities
        .filter((activity) => activity.phase === "exec")
        .map((activity) => activity.nodeId),
    ).toEqual(["implement_api", "validate_api"]);
    expect(
      store.graphRecords.some(
        (record) => record.recordType === "op" && record.type === "graph_seeded",
      ),
    ).toBe(true);
    expect(store.events.map((event) => event.type)).toContain("graph_expanded");
  });

  it("feeds meta prompt node instructions into scheduled exec nodes", async () => {
    const store = new MemoryWorkflowStore();
    const execPrompts: string[] = [];
    let now = 0;
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          if (input.phase === "arch_decompose") {
            return {
              response: JSON.stringify({
                nodes: [
                  {
                    description: "Implement the public API.",
                    id: "implement_api",
                    title: "Implement API",
                  },
                ],
              }),
              sessionId: "sess-arch",
            };
          }
          if (input.phase === "meta_prompt") {
            return {
              response: JSON.stringify({
                nodePrompts: {
                  implement_api: {
                    description: "Implement only the public API boundary.",
                    instructions: "Preserve existing validation behavior and add focused tests.",
                    title: "Implement public API boundary",
                  },
                },
                reasoning: "node instructions refined",
              }),
              sessionId: "sess-meta",
            };
          }
          if (input.phase === "exec") {
            execPrompts.push(input.prompt);
          }
          if (input.phase === "final_critic") {
            return {
              response: JSON.stringify({
                reasoning: "meta prompt fed scheduler",
                verdict: "pass",
              }),
              sessionId: "sess-final",
            };
          }
          return {
            response: `# ${input.phase}\n\nok`,
            sessionId: `sess-${input.phase}`,
          };
        },
      },
      createRunId: () => "wf_meta_prompt_nodes",
      now: () => new Date(1_700_000_000_000 + now++),
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "ship meta prompt node instructions",
    });

    expect(result.status).toBe("completed");
    expect(execPrompts).toHaveLength(1);
    expect(execPrompts[0]).toContain("Node: Implement public API boundary");
    expect(execPrompts[0]).toContain("Implement only the public API boundary.");
    expect(execPrompts[0]).toContain("Preserve existing validation behavior and add focused tests.");
    expect(result.snapshot?.graph.nodes.find((node) => node.id === "implement_api")).toMatchObject({
      description: "Implement only the public API boundary.",
      prompt: "Preserve existing validation behavior and add focused tests.",
      title: "Implement public API boundary",
    });
    expect(
      store.graphRecords.some(
        (record) => record.recordType === "op" && record.type === "node_prompts_updated",
      ),
    ).toBe(true);
    expect(
      store.events.some((event) => {
        const nodeIds = event.payload?.nodeIds;
        return (
          event.type === "graph_updated" &&
          Array.isArray(nodeIds) &&
          nodeIds.includes("implement_api")
        );
      }),
    ).toBe(true);
  });

  it("reopens critic-proposed nodes and reruns the generic scheduler", async () => {
    const store = new MemoryWorkflowStore();
    const phases: string[] = [];
    let criticCalls = 0;
    let now = 0;
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          phases.push(input.phase);
          if (input.phase === "final_critic") {
            criticCalls++;
            return {
              response:
                criticCalls === 1
                  ? JSON.stringify({
                      reasoning: "exec output missed validation",
                      reopen_proposals: [
                        {
                          node_name: "phase:exec",
                          reason: "rerun validation node",
                          severity: "major",
                        },
                      ],
                      verdict: "fail",
                    })
                  : JSON.stringify({
                      reasoning: "fixed",
                      verdict: "pass",
                    }),
              sessionId: `sess-${input.phase}-${criticCalls}`,
            };
          }
          return {
            response: `# ${input.phase}\n\nok ${phases.length}`,
            sessionId: `sess-${input.phase}-${phases.length}`,
          };
        },
      },
      createRunId: () => "wf_reopen",
      now: () => new Date(1_700_000_000_000 + now++),
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "ship critic reopen",
    });

    expect(result.status).toBe("completed");
    expect(phases.filter((phase) => phase === "exec")).toHaveLength(2);
    expect(phases.filter((phase) => phase === "final_critic")).toHaveLength(2);
    expect(result.snapshot?.graph.nodes.find((node) => node.id === "phase:exec")).toMatchObject({
      reopenAttempts: 1,
      status: "completed",
    });
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["critic_failed", "node_reopened", "critic_passed"]),
    );
    expect(
      store.graphRecords.some(
        (record) =>
          record.recordType === "op" &&
          record.type === "reopen_node" &&
          record.nodeId === "phase:exec",
      ),
    ).toBe(true);
  });

  it("stops critic iteration when a fail verdict has no reopen proposal", async () => {
    const store = new MemoryWorkflowStore();
    const phases: string[] = [];
    let now = 0;
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          phases.push(input.phase);
          if (input.phase === "final_critic") {
            return {
              response: JSON.stringify({
                acceptanceGaps: ["manual review still needed"],
                reasoning: "cannot map issue to a node",
                reopenProposals: [],
                verdict: "fail",
              }),
              sessionId: "sess-final-critic",
            };
          }
          return {
            response: `# ${input.phase}\n\nok`,
            sessionId: `sess-${input.phase}`,
          };
        },
      },
      createRunId: () => "wf_empty_fail",
      now: () => new Date(1_700_000_000_000 + now++),
      store,
    });

    const result = await runtime.start({
      cwd: "/repo",
      task: "ship empty critic fail",
    });

    expect(result.status).toBe("completed");
    expect(phases.filter((phase) => phase === "exec")).toHaveLength(1);
    expect(phases.filter((phase) => phase === "final_critic")).toHaveLength(1);
    expect(store.events.map((event) => event.type)).toContain("critic_failed");
    expect(store.events.map((event) => event.type)).not.toContain("node_reopened");
  });

  it("pauses failed child sessions and retries with a new linked session", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;
    const definition: WorkflowDefinition = {
      definitionId: "repairable",
      definitionVersion: "1",
      kind: "repairable",
      phaseOrder: ["work", "complete"],
      phases: [
        {
          behavior: "agent",
          description: "Do repairable work.",
          phase: "work",
          title: "Work",
        },
        {
          behavior: "complete",
          description: "Complete the workflow.",
          phase: "complete",
          title: "Complete",
        },
      ],
      strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      title: "Repairable Workflow",
    };
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async (input) => {
          calls++;
          await input.onChildSessionStarted?.({
            model: `test/model-${calls}`,
            sessionId: `sess-${calls}`,
            traceId: `trace-${calls}`,
            turnId: `turn-${calls}`,
          });
          if (calls === 1) {
            throw new Error("network down");
          }
          return {
            model: `test/model-${calls}`,
            response: "# work\n\nok",
            sessionId: `sess-${calls}`,
            traceId: `trace-${calls}`,
            turnId: `turn-${calls}`,
          };
        },
      },
      createRunId: () => "wf_repairable",
      definition,
      now: () => new Date(`2026-05-05T00:00:0${Math.min(calls, 9)}.000Z`),
      store,
    });

    const paused = await runtime.start({
      cwd: "/repo",
      task: "recover after network failure",
    });

    expect(paused.status).toBe("paused");
    expect(paused.snapshot?.failure).toMatchObject({
      activityId: expect.any(String),
      message: "network down",
      phase: "work",
    });
    expect(paused.snapshot?.recoveryActions.map((action) => action.action)).toEqual([
      "retry",
      "retry_with_current_model",
      "cancel",
    ]);
    expect(paused.snapshot?.sessionLinks).toEqual([
      expect.objectContaining({
        activityId: expect.any(String),
        attempt: 1,
        model: "test/model-1",
        phase: "work",
        sessionId: "sess-1",
        status: "failed",
      }),
    ]);

    const completed = await runtime.retry({
      cwd: "/repo",
      runId: "wf_repairable",
    });

    expect(completed.status).toBe("completed");
    expect(completed.snapshot?.failure).toBeUndefined();
    expect(completed.snapshot?.sessionLinks).toEqual([
      expect.objectContaining({
        attempt: 1,
        model: "test/model-1",
        sessionId: "sess-1",
        status: "failed",
      }),
      expect.objectContaining({
        attempt: 2,
        model: "test/model-2",
        sessionId: "sess-2",
        status: "completed",
      }),
    ]);
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workflow_paused",
        "workflow_retry_started",
        "workflow_session_linked",
      ]),
    );
  });

  it("marks the latest run cancelled", async () => {
    const store = new MemoryWorkflowStore();
    const runtime = new ExpertWorkflowRuntime({
      agentRunner: {
        run: async () => ({
          response: "unused",
          sessionId: "sess-unused",
        }),
      },
      createRunId: () => "wf_cancel",
      now: () => new Date("2026-05-05T00:00:00Z"),
      store,
    });

    await store.writeSnapshot({
      activities: [
        {
          activityId: "act-exec",
          inputArtifactPaths: [],
          kind: "agent_session",
          nodeId: "phase:clarify",
          outputArtifactPaths: [],
          phase: "clarify",
          startedAt: "2026-05-05T00:00:00.000Z",
          status: "active",
        },
      ],
      artifacts: [],
      createdAt: "2026-05-05T00:00:00.000Z",
      cwd: "/repo",
      graph: {
        edges: [],
        nodes: [
          {
            dependsOn: [],
            id: "phase:clarify",
            kind: "phase",
            phase: "clarify",
            status: "active",
            title: "Clarify",
          },
        ],
      },
      kind: "expert",
      phaseOrder: ["clarify"],
      phases: [
        {
          activityId: "act-exec",
          phase: "clarify",
          status: "active",
        },
      ],
      runId: "wf_cancel",
      schemaVersion: 1,
      status: "running",
      strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      task: "work",
      updatedAt: "2026-05-05T00:00:00.000Z",
    });

    const result = await runtime.cancel({
      cwd: "/repo",
    });

    expect(result.status).toBe("cancelled");
    const cancelled = await store.readRun("wf_cancel");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.graph.nodes[0]?.status).toBe("cancelled");
    expect(cancelled?.phases[0]?.status).toBe("cancelled");
    expect(cancelled?.activities[0]?.status).toBe("cancelled");
    expect(store.graphRecords.some((record) => record.recordType === "op")).toBe(true);
  });
});
