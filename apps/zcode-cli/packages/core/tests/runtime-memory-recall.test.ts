import {
  createSessionId,
  getCurrentModelInvocationContext,
  type ModelInvocationContext,
  type SessionTaskType,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  consumeSettledProjectMemoryRecall,
  invalidateProjectMemoryRecallPaths,
  resetProjectMemoryRecall,
  startProjectMemoryRecallPrefetch,
} from "../src/runtime/helpers/project-memory-recall.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";

const CLI_STORAGE_ROOT = "/storage/cli";
const WORKSPACE_PATH = "/workspace/project";
const RELEVANT_MEMORY_SOURCE = "relevant_memory";

describe("AgentRuntime default project Memory branch", () => {
  it("does not start Selector or inject relevant_memory across a Main tool continuation", async () => {
    let mainRequestCount = 0;
    let selectorRequestCount = 0;
    const registry = recallBoundaryRegistry();
    const runtime = createRecallRuntime({
      registry,
      sessionName: "runtime-memory-default-branch",
      async generateText(request: any) {
        if (request.responseJsonSchema) {
          selectorRequestCount += 1;
          return textResult(request, '{"selected_memories":["database-policy.md"]}');
        }
        mainRequestCount += 1;
        if (mainRequestCount === 1) return toolCallResult("default-memory-boundary", request);
        return textResult(request, "done");
      },
    });

    await runtime.executeTurn("database policy");

    expect(mainRequestCount).toBe(2);
    expect(selectorRequestCount).toBe(0);
    expect((runtime as any).memoryRecallPrefetch).toBeUndefined();
    const recallAttachments = (runtime as any).messageHistory
      .toRuntimeEntries()
      .filter((entry: any) => entry.metadata?.source === RELEVANT_MEMORY_SOURCE);
    expect(recallAttachments).toHaveLength(0);
  });

  it("runs and consumes Semantic Recall only when the semantic-recall branch is selected", async () => {
    let selectorRequestCount = 0;
    let selectorContext: ModelInvocationContext | undefined;
    const generateText = async (request: any) => {
      if (request.responseJsonSchema) {
        selectorRequestCount += 1;
        selectorContext = getCurrentModelInvocationContext();
        return textResult(request, '{"selected_memories":["database-policy.md"]}');
      }
      return textResult(request, "done");
    };
    const runtime = createRecallRuntime({
      sessionName: "runtime-memory-semantic-branch",
      workspaceIdentity: "ssh://host/workspace",
      generateText,
    });

    await runtime.executeTurn("please apply the database policy");
    startProjectMemoryRecallPrefetch(
      runtime as any,
      {
        model: createRuntimeModel(runtime as never, {
          selection: runtime.getSessionModelSelection(),
        }),
        traceContext: { traceId: "trace-semantic-memory-recall" } as never,
        turnAbortSignal: new AbortController().signal,
      },
      "semantic-recall",
    );
    await vi.waitFor(() => {
      expect((runtime as any).memoryRecallPrefetch?.settled).toBe(true);
    });

    consumeSettledProjectMemoryRecall(runtime as any, "semantic-recall");
    consumeSettledProjectMemoryRecall(runtime as any, "semantic-recall");

    expect(selectorRequestCount).toBe(1);
    expect(selectorContext).toMatchObject({
      modelRequestSessionType: "main",
      metadata: { querySource: "project_memory_recall" },
    });
    const recallAttachments = (runtime as any).messageHistory
      .toRuntimeEntries()
      .filter((entry: any) => entry.metadata?.source === RELEVANT_MEMORY_SOURCE);
    expect(recallAttachments).toHaveLength(1);
    expect(String(recallAttachments[0]?.content)).toContain(
      "Database tests use the real database.",
    );
  });

  it("does not start Semantic Recall when the Turn Model lacks strict schema output", async () => {
    let selectorRequestCount = 0;
    const generateText = async (request: any) => {
      if (request.responseJsonSchema) selectorRequestCount += 1;
      return textResult(request, request.responseJsonSchema ? '{"selected_memories":[]}' : "done");
    };
    const runtime = createRecallRuntime({
      generateText,
      sessionName: "runtime-memory-semantic-unsupported-schema",
    });
    await runtime.executeTurn("please apply the database policy");

    startProjectMemoryRecallPrefetch(
      runtime as any,
      {
        model: createTestRuntimeModel({
          generateText,
          propertyOverrides: { supportsJsonSchemaOutput: false },
        }),
        traceContext: { traceId: "trace-semantic-unsupported-schema" } as never,
        turnAbortSignal: new AbortController().signal,
      },
      "semantic-recall",
    );

    expect(selectorRequestCount).toBe(0);
    expect((runtime as any).memoryRecallPrefetch).toBeUndefined();
  });

  it.each<{
    memory?: { enabled?: boolean; use?: boolean };
    name: string;
    taskType?: SessionTaskType;
  }>([
    { memory: { enabled: false }, name: "disabled feature" },
    { memory: { use: false }, name: "disabled use" },
    { name: "child task", taskType: "subagent_child" },
  ])("does not start Recall for $name", async ({ memory, name, taskType }) => {
    let selectorRequestCount = 0;
    const runtime = createRecallRuntime({
      memory,
      sessionName: `runtime-memory-recall-${name.replaceAll(" ", "-")}`,
      taskType,
      async generateText(request: any) {
        if (request.responseJsonSchema) selectorRequestCount += 1;
        return textResult(
          request,
          request.responseJsonSchema ? '{"selected_memories":[]}' : "done",
        );
      },
    });

    await runtime.executeTurn("please apply the database policy");
    expect(selectorRequestCount).toBe(0);
  });

  it("resets all session-local Recall state and aborts an unfinished prefetch", () => {
    const runtime = createRecallRuntime({
      sessionName: "runtime-memory-recall-reset",
      async generateText(request: any) {
        return textResult(request, "done");
      },
    });
    const previousState = (runtime as any).memoryRecallState;
    previousState.manifest = [
      {
        filePath: "/memory/fact.md",
        filename: "fact.md",
        mtimeMs: 1,
      },
    ];
    previousState.selectorMessages = [{ role: "user", content: "manifest" }];
    previousState.recalledPaths.add("/memory/fact.md");
    previousState.recalledContentCharacters = 42;
    const abortController = new AbortController();
    let detached = false;
    (runtime as any).memoryRecallPrefetch = {
      abortController,
      consumed: false,
      detachTurnAbort: () => {
        detached = true;
      },
      memories: [],
      settled: false,
    };

    resetProjectMemoryRecall(runtime as any);

    expect((runtime as any).memoryRecallState).not.toBe(previousState);
    expect((runtime as any).memoryRecallState).toMatchObject({
      recalledContentCharacters: 0,
      recalledPaths: new Set(),
    });
    expect((runtime as any).memoryRecallState.manifest).toBeUndefined();
    expect((runtime as any).memoryRecallState.selectorMessages).toBeUndefined();
    expect((runtime as any).memoryRecallPrefetch).toBeUndefined();
    expect(abortController.signal.aborted).toBe(true);
    expect(detached).toBe(true);
  });

  it("disposes prefetched content when Dream invalidates a touched path", () => {
    const runtime = createRecallRuntime({
      sessionName: "runtime-memory-recall-dream-invalidation",
      async generateText(request: any) {
        return textResult(request, "done");
      },
    });
    const memoryPath = `${resolveProjectMemoryRoot({
      cliStorageRoot: CLI_STORAGE_ROOT,
      workspacePath: WORKSPACE_PATH,
    })}/database-policy.md`;
    const abortController = new AbortController();
    let detached = false;
    (runtime as any).memoryRecallPrefetch = {
      abortController,
      consumed: false,
      detachTurnAbort: () => {
        detached = true;
      },
      memories: [
        {
          content: "stale prefetched content",
          entry: { filePath: memoryPath, filename: "database-policy.md", mtimeMs: 1 },
        },
      ],
      settled: true,
    };

    invalidateProjectMemoryRecallPaths(runtime as any, [memoryPath]);

    expect((runtime as any).memoryRecallPrefetch).toBeUndefined();
    expect(abortController.signal.aborted).toBe(true);
    expect(detached).toBe(true);
  });
});

function createRecallRuntime(input: {
  generateText: (request: any) => Promise<Record<string, unknown>>;
  memory?: { enabled?: boolean; use?: boolean };
  registry?: ReturnType<typeof createToolRegistry>;
  sessionName: string;
  taskType?: SessionTaskType;
  workspaceIdentity?: string;
}): AgentRuntime {
  const rootDir = resolveProjectMemoryRoot({
    cliStorageRoot: CLI_STORAGE_ROOT,
    workspaceIdentity: input.workspaceIdentity,
    workspacePath: WORKSPACE_PATH,
  });
  const fileSystemPort = new RecallMemoryFileSystem({
    [`${rootDir}/database-policy.md`]: [
      "---",
      "name: database-policy",
      "description: Database tests use the real database.",
      "metadata:",
      "  type: project",
      "---",
      "",
      "Database tests use the real database.",
    ].join("\n"),
  });

  return createTestAgentRuntime(
    createSessionId(input.sessionName),
    {
      memory: {
        cliStorageRoot: CLI_STORAGE_ROOT,
        enabled: true,
        use: true,
        workspaceIdentity: input.workspaceIdentity,
        ...input.memory,
      },
      mode: "yolo",
      taskType: input.taskType,
      workingDirectory: WORKSPACE_PATH,
    },
    {
      eventStore: createTestSessionEventStore(),
      fileSystemPort,
      modelFactory: createTestModelFactory({
        generateText: input.generateText,
        properties: { supportsMidConversationSystem: true },
      } as never),
      toolRegistry: input.registry,
    },
  );
}

function recallBoundaryRegistry() {
  const registry = createToolRegistry();
  registry.register({
    inputSchema: {},
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name: "CompleteRecallBoundary",
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async () => "tool complete",
  });
  return registry;
}

function toolCallResult(id: string, request?: any): Record<string, unknown> {
  return {
    finishReason: "tool-calls",
    model: request?.model,
    providerMetadata: undefined,
    text: "",
    toolCalls: [{ id, input: {}, name: "CompleteRecallBoundary" }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function textResult(request: any, text: string): Record<string, unknown> {
  return {
    finishReason: "stop",
    model: request?.model,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

class RecallMemoryFileSystem extends MemoryFileSystem {
  override async stat(request: { path: string }) {
    return {
      ...(await super.stat(request)),
      mtimeMs: 1,
    };
  }
}
