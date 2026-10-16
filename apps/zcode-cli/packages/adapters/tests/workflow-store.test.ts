import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@zcode/contracts";
import {
  createNodeWorkflowDefinitionStore,
  createNodeWorkflowStore,
  getDefaultWorkflowDefinitionsRoot,
  getDefaultWorkflowRoot,
} from "../src/workflow/index.js";

describe("Node workflow store", () => {
  it("defaults to the CLI workflows directory", () => {
    expect(getDefaultWorkflowRoot()).toContain(join(".zcode", "cli", "workflows"));
    expect(getDefaultWorkflowDefinitionsRoot()).toContain(
      join(".zcode", "cli", "workflows", "definitions"),
    );
  });

  it("persists snapshots, events, graph records, artifacts, and index", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-store-"));
    const store = createNodeWorkflowStore({ rootDir: tempRoot });
    const snapshot: WorkflowRunSnapshot = {
      activities: [],
      artifacts: [],
      createdAt: "2026-05-05T00:00:00.000Z",
      cwd: "/repo",
      graph: {
        edges: [],
        nodes: [],
      },
      kind: "expert",
      phaseOrder: ["clarify"],
      phases: [
        {
          phase: "clarify",
          status: "pending",
        },
      ],
      runId: "wf_test",
      schemaVersion: 1,
      status: "running",
      strategy: {
        clarify: {
          confidenceThreshold: 0.8,
          maxRounds: 3,
          minRounds: 1,
        },
        executor: {
          drainingChangeHours: 1,
          frontierTarget: 3,
          maxConcurrentLoops: 2,
          maxConsecutiveErrors: 3,
          maxPlannerRuns: 10,
        },
        finalCritic: {
          maxIterations: 3,
        },
        reactLoop: {
          maxRounds: 30,
        },
      },
      task: "work",
      updatedAt: "2026-05-05T00:00:00.000Z",
    };

    try {
      await store.writeSnapshot(snapshot);
      await store.appendEvent({
        kind: "expert",
        runId: "wf_test",
        timestamp: "2026-05-05T00:00:01.000Z",
        type: "run_started",
      });
      await store.appendGraphRecord("wf_test", {
        nodeId: "phase:clarify",
        phase: "clarify",
        recordType: "op",
        runId: "wf_test",
        status: "active",
        timestamp: "2026-05-05T00:00:02.000Z",
        type: "update_status",
      });
      const artifact = await store.writeArtifact("wf_test", "artifacts/clarify.md", "# ok\n");

      expect(artifact.relativePath).toBe("artifacts/clarify.md");
      expect((await store.readRun("wf_test"))?.task).toBe("work");
      expect((await store.readLatestRun({ cwd: "/repo", kind: "expert" }))?.runId).toBe("wf_test");
      expect(await store.readEvents("wf_test")).toHaveLength(1);
      expect(await readFile(join(tempRoot, "runs", "wf_test", "graph.jsonl"), "utf8")).toContain(
        "update_status",
      );
      expect((await store.listRuns({ cwd: "/repo", kind: "expert" }))[0]?.runId).toBe("wf_test");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("loads workflow definitions from the definitions directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-definitions-"));
    const definitionsDir = join(tempRoot, "definitions");
    await mkdir(definitionsDir, { recursive: true });
    await writeFile(
      join(definitionsDir, "audit.json"),
      `${JSON.stringify(createDefinition("audit", "1"), null, 2)}\n`,
      "utf8",
    );
    const store = createNodeWorkflowDefinitionStore({ rootDir: tempRoot });

    try {
      await expect(store.readDefinition("../audit")).rejects.toThrow("file-safe name");
      const definition = await store.readDefinition("audit");
      expect(definition?.definitionId).toBe("audit");
      expect(definition?.definitionVersion).toBe("1");
      expect((await store.listDefinitions()).map((item) => item.definitionId)).toEqual(["audit"]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects malformed workflow definition files before runtime creation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-definitions-"));
    const definitionsDir = join(tempRoot, "definitions");
    await mkdir(definitionsDir, { recursive: true });
    await writeFile(
      join(definitionsDir, "broken.json"),
      `${JSON.stringify({ ...createDefinition("broken", "1"), phaseOrder: ["missing"] })}\n`,
      "utf8",
    );
    const store = createNodeWorkflowDefinitionStore({ rootDir: tempRoot });

    try {
      await expect(store.readDefinition("broken")).rejects.toThrow("unknown phase");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

function createDefinition(definitionId: string, definitionVersion: string) {
  return {
    definitionId,
    definitionVersion,
    kind: definitionId,
    phaseOrder: ["inspect", "complete"],
    phases: [
      {
        behavior: "agent",
        description: "Inspect the workspace.",
        phase: "inspect",
        title: "Inspect",
      },
      {
        behavior: "complete",
        description: "Write the report.",
        phase: "complete",
        title: "Complete",
      },
    ],
    strategy: {
      clarify: {
        confidenceThreshold: 0.8,
        maxRounds: 3,
        minRounds: 1,
      },
      executor: {
        drainingChangeHours: 1,
        frontierTarget: 3,
        maxConcurrentLoops: 2,
        maxConsecutiveErrors: 3,
        maxPlannerRuns: 10,
      },
      finalCritic: {
        maxIterations: 3,
      },
      reactLoop: {
        maxRounds: 30,
      },
    },
    title: `${definitionId} workflow`,
  };
}
