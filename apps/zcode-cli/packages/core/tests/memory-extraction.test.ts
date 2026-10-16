import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createSessionId,
  type MessageId,
  type MessagePart,
  type MessageWithParts,
  type ToolState,
} from "@zcode/contracts";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  evaluateMemoryExtraction,
  type MemoryExtractionExecutionStatus,
  type MemoryExtractionSnapshot,
} from "../src/memory/extraction.js";

const SESSION_ID = createSessionId("memory-extraction");
const PROVIDER_ID = createModelProviderId("test-provider");
const MODEL_ID = createModelId("test-model");
const WORKSPACE_ROOT = "/workspace";
const MEMORY_ROOT = "/storage/memories/project/memory";

describe("memory extraction prompt", () => {
  it("matches the frozen provider-visible fixture", () => {
    const timestamp = "2026-07-16T01:02:03.000Z";
    const fixture = readFileSync(
      new URL("./fixtures/memory/extraction-prompt.md", import.meta.url),
      "utf8",
    )
      .trimEnd()
      .replace("<TIMESTAMP>", timestamp);

    expect(
      buildMemoryExtractionPrompt({
        manifest: [
          {
            description: "Database tests must use the real database rather than mocks.",
            filePath: `${MEMORY_ROOT}/database-test-policy.md`,
            filename: "database-test-policy.md",
            mtimeMs: Date.parse(timestamp),
            type: "feedback",
          },
        ],
        messageCount: 2,
      }),
    ).toBe(fixture);
  });

  it("omits the existing-memory section when the manifest is empty", () => {
    const prompt = buildMemoryExtractionPrompt({ manifest: [], messageCount: 4 });

    expect(prompt).toContain("most recent ~4 messages");
    expect(prompt).not.toContain("## Existing memory files");
  });
});

describe("memory extraction gate", () => {
  it("requires one independent non-meta user text block with at least three words", () => {
    const cursor = userMessage("cursor", ["previous durable request"]);
    const shortBlocks = userMessage("short-blocks", ["one two", "three four"]);
    const meta = userMessage("meta", ["meta text has words"], { synthetic: true });
    const modelOnly = userMessage("model-only", ["hidden text has words"], {
      visibility: "model-only",
    });

    expect(
      evaluateMemoryExtraction(snapshot([cursor, shortBlocks, meta, modelOnly]), cursor.info.id),
    ).toEqual({ decision: "skip", messageCount: 3, reason: "no-user-prose" });

    const eligible = userMessage("eligible", ["one two", "one two three"]);
    expect(evaluateMemoryExtraction(snapshot([cursor, eligible]), cursor.info.id)).toEqual({
      decision: "run",
      messageCount: 1,
    });
  });

  it("skips after a contained Write or Edit regardless of tool status and filename extension", () => {
    const cursor = userMessage("cursor", ["previous durable request"]);
    const prose = userMessage("prose", ["save this durable preference"]);
    const statuses: ToolState[] = [
      { status: "pending", input: { file_path: join(MEMORY_ROOT, "pending.txt") }, raw: "" },
      {
        status: "error",
        input: { file_path: join(MEMORY_ROOT, "failed-without-extension") },
        error: "write failed",
        time: { start: 1, end: 2 },
      },
    ];

    for (const [index, state] of statuses.entries()) {
      const write = assistantToolMessage(`write-${index}`, index === 0 ? "Write" : "Edit", state);
      expect(evaluateMemoryExtraction(snapshot([cursor, prose, write]), cursor.info.id)).toEqual({
        decision: "skip",
        messageCount: 2,
        reason: "direct-memory-write",
      });
    }

    const outsideWrite = assistantToolMessage("outside", "Write", {
      status: "completed",
      input: { file_path: "/workspace/not-memory.md" },
      output: "ok",
      title: "write",
      metadata: {},
      time: { start: 1, end: 2 },
    });
    expect(
      evaluateMemoryExtraction(snapshot([cursor, prose, outsideWrite]), cursor.info.id),
    ).toEqual({ decision: "run", messageCount: 2 });
  });

  it("does not backscan direct writes when a non-empty cursor is missing", () => {
    const oldWrite = assistantToolMessage("old-write", "Write", {
      status: "completed",
      input: { file_path: join(MEMORY_ROOT, "old.md") },
      output: "ok",
      title: "write",
      metadata: {},
      time: { start: 1, end: 2 },
    });
    const prose = userMessage("new-prose", ["new durable preference here"]);

    expect(
      evaluateMemoryExtraction(snapshot([oldWrite, prose]), createMessageId("missing-cursor")),
    ).toEqual({ decision: "run", messageCount: 2 });
  });

  it("backscans prose when a non-empty cursor is missing", () => {
    const prose = userMessage("old-prose", ["durable preference remains useful"]);

    expect(evaluateMemoryExtraction(snapshot([prose]), createMessageId("missing-cursor"))).toEqual({
      decision: "run",
      messageCount: 1,
    });
  });
});

describe("memory extraction scheduler", () => {
  it("reports pending work from schedule until the running extraction settles", async () => {
    const run = deferred<MemoryExtractionExecutionStatus>();
    const scheduler = createMemoryExtractionScheduler(async () => run.promise);

    expect(scheduler.hasPendingWork()).toBe(false);
    scheduler.schedule(snapshot([userMessage("pending", ["durable preference remains useful"])]));
    expect(scheduler.hasPendingWork()).toBe(true);

    run.resolve("success");
    await scheduler.drain();
    expect(scheduler.hasPendingWork()).toBe(false);
  });

  it("keeps one running extraction and replaces pending work with only the latest snapshot", async () => {
    const firstRun = deferred<MemoryExtractionExecutionStatus>();
    const executed: string[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot: input }) => {
      const id = input.durableMessages.at(-1)?.info.id;
      if (id) executed.push(id);
      if (id === createMessageId("a")) return firstRun.promise;
      return "success";
    });

    scheduler.schedule(snapshot([userMessage("a", ["alpha durable preference"])]));
    scheduler.schedule(snapshot([userMessage("b", ["beta durable preference"])]));
    scheduler.schedule(snapshot([userMessage("c", ["gamma durable preference"])]));

    await nextTask();
    expect(executed).toEqual([createMessageId("a")]);
    firstRun.resolve("success");
    await scheduler.drain();

    expect(executed).toEqual([createMessageId("a"), createMessageId("c")]);
    expect(scheduler.getCursor()).toBe(createMessageId("c"));
  });

  it.each(["success", "no-op"] as const)("advances the cursor after %s", async (status) => {
    const scheduler = createMemoryExtractionScheduler(async () => status);
    scheduler.schedule(snapshot([userMessage(status, ["durable preference to save"])]));

    await scheduler.drain();

    expect(scheduler.getCursor()).toBe(createMessageId(status));
  });

  it.each(["error", "aborted"] as const)("does not advance the cursor after %s", async (status) => {
    const scheduler = createMemoryExtractionScheduler(async () => status);
    scheduler.schedule(snapshot([userMessage(status, ["durable preference to save"])]));

    await scheduler.drain();

    expect(scheduler.getCursor()).toBeUndefined();
  });

  it("advances the cursor on direct-write and no-prose skips without executing the model callback", async () => {
    const executed: string[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot: input }) => {
      executed.push(input.durableMessages.at(-1)!.info.id);
      return "success";
    });
    const directWrite = assistantToolMessage("direct-write", "Write", {
      status: "error",
      input: { file_path: join(MEMORY_ROOT, "direct") },
      error: "failed",
      time: { start: 1, end: 2 },
    });

    scheduler.schedule(snapshot([directWrite]));
    await scheduler.drain();
    expect(scheduler.getCursor()).toBe(createMessageId("direct-write"));

    scheduler.schedule(
      snapshot([
        directWrite,
        userMessage("no-prose", ["one two", "three four"], { synthetic: false }),
      ]),
    );
    await scheduler.drain();

    expect(executed).toEqual([]);
    expect(scheduler.getCursor()).toBe(createMessageId("no-prose"));
  });

  it("does not advance on a thrown execution error and still runs the latest pending snapshot", async () => {
    const firstRun = deferred<void>();
    const executed: string[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot: input }) => {
      const id = input.durableMessages.at(-1)!.info.id;
      executed.push(id);
      if (id === createMessageId("throws")) {
        await firstRun.promise;
        throw new Error("model failed");
      }
      return "success";
    });

    scheduler.schedule(snapshot([userMessage("throws", ["first durable preference"])]));
    scheduler.schedule(snapshot([userMessage("latest", ["latest durable preference"])]));
    firstRun.resolve();
    await scheduler.drain();

    expect(executed).toEqual([createMessageId("throws"), createMessageId("latest")]);
    expect(scheduler.getCursor()).toBe(createMessageId("latest"));
  });

  it("does not strand a snapshot scheduled while the running extraction completes", async () => {
    const firstRun = deferred<MemoryExtractionExecutionStatus>();
    const executed: string[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot: input }) => {
      const id = input.durableMessages.at(-1)!.info.id;
      executed.push(id);
      if (id === createMessageId("first")) return firstRun.promise;
      return "success";
    });

    scheduler.schedule(snapshot([userMessage("first", ["first durable preference"])]));
    await nextTask();

    const scheduleDuringCleanup = new Promise<void>((resolve) => {
      void firstRun.promise.then(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            scheduler.schedule(
              snapshot([userMessage("during-cleanup", ["latest durable preference"])]),
            );
            resolve();
          });
        });
      });
    });
    firstRun.resolve("success");
    await scheduleDuringCleanup;
    await scheduler.drain();

    expect(executed).toEqual([createMessageId("first"), createMessageId("during-cleanup")]);
    expect(scheduler.getCursor()).toBe(createMessageId("during-cleanup"));
  });

  it("does not advance the cursor for a snapshot acquisition error and still runs latest pending", async () => {
    const executed: string[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot: input }) => {
      executed.push(input.boundaryMessageId);
      return "success";
    });

    scheduler.schedule(Promise.reject(new Error("boundary missing")));
    scheduler.schedule(snapshot([userMessage("latest", ["latest durable preference"])]));
    await scheduler.drain();

    expect(executed).toEqual([createMessageId("latest")]);
    expect(scheduler.getCursor()).toBe(createMessageId("latest"));
  });

  it("aborts the running extraction, drops pending work, and rejects later schedules on shutdown", async () => {
    const runningSignal = deferred<AbortSignal>();
    const executed: MessageId[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ abortSignal, snapshot: input }) => {
      executed.push(input.boundaryMessageId);
      runningSignal.resolve(abortSignal);
      await waitForAbort(abortSignal);
      return "aborted";
    });

    scheduler.schedule(snapshot([userMessage("running", ["running durable preference"])]));
    const signal = await runningSignal.promise;
    scheduler.schedule(snapshot([userMessage("pending", ["pending durable preference"])]));

    scheduler.shutdown();
    await scheduler.drain();
    scheduler.schedule(snapshot([userMessage("after-close", ["later durable preference"])]));
    await nextTask();

    expect(signal.aborted).toBe(true);
    expect(executed).toEqual([createMessageId("running")]);
    expect(scheduler.getCursor()).toBeUndefined();
  });

  it("stops waiting for snapshot acquisition when shutdown starts", async () => {
    const snapshotGate = deferred<MemoryExtractionSnapshot>();
    let executeCount = 0;
    const scheduler = createMemoryExtractionScheduler(async () => {
      executeCount += 1;
      return "success";
    });

    scheduler.schedule(snapshotGate.promise);
    scheduler.shutdown();
    await scheduler.drain();

    expect(executeCount).toBe(0);
    expect(scheduler.getCursor()).toBeUndefined();
  });
});

function snapshot(messages: MessageWithParts[]): MemoryExtractionSnapshot {
  return {
    boundaryMessageId: messages.at(-1)!.info.id,
    durableMessages: messages,
    memoryRoot: MEMORY_ROOT,
    workingDirectory: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
  };
}

function userMessage(
  id: string,
  textBlocks: string[],
  options: { synthetic?: boolean; visibility?: "model-only" | "user-visible" } = {},
): MessageWithParts {
  const messageId = createMessageId(id);
  return {
    info: {
      id: messageId,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 1 },
      agent: "zcode-agent",
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
      synthetic: options.synthetic,
      visibility: options.visibility,
    },
    parts: textBlocks.map((text, index) => ({
      id: createPartId(`${id}-${index}`),
      sessionID: SESSION_ID,
      messageID: messageId,
      type: "text",
      text,
    })),
  };
}

function assistantToolMessage(
  id: string,
  tool: "Edit" | "Write",
  state: ToolState,
): MessageWithParts {
  const messageId = createMessageId(id);
  const parentId = createMessageId(`${id}-parent`);
  const part: MessagePart = {
    id: createPartId(`${id}-tool`),
    sessionID: SESSION_ID,
    messageID: messageId,
    type: "tool",
    callID: `${id}-call`,
    tool,
    state,
  };
  return {
    info: {
      id: messageId,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: parentId,
      agent: "zcode-agent",
      cost: 0,
      mode: "build",
      modelID: MODEL_ID,
      path: { cwd: WORKSPACE_ROOT, root: WORKSPACE_ROOT },
      providerID: PROVIDER_ID,
      tokens: {
        cache: { read: 0, write: 0 },
        input: 0,
        output: 0,
        reasoning: 0,
      },
    },
    parts: [part],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
