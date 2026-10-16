import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type MessagePart,
  type ModelInputMessage,
  type ModelRequest,
  type SessionStorePort,
  type ToolPart,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const CALL_ID = "stream-read";
const READ_OUTPUT = "read succeeded";
const READ_ERROR = "read failed";
const WRITE_ERROR = "injected session write failure";
const INTERRUPTED_RESULT = "[Tool execution was interrupted before resume]";

type FallbackOutcome =
  | "success"
  | "tool-error"
  | "pending-error"
  | "running-error"
  | "result-error";

function createFixture(
  options: {
    outcome?: FallbackOutcome;
    streamFailure?: boolean;
    earlyWriteFailure?: "pending" | "running" | false;
    delayEarlySchedule?: boolean;
  } = {},
) {
  const sessionId = createSessionId("streaming-part-identity");
  const store = {
    ...createRecordingMessageStore(),
    async getProjectPermission() {
      return null;
    },
  };
  const writes: ToolPart[] = [];
  const requests: ModelRequest[] = [];
  const earlyFailure = Promise.withResolvers<void>();
  const scheduleStarted = Promise.withResolvers<void>();
  const releaseSchedule = Promise.withResolvers<void>();
  const lateExecutionSettled = Promise.withResolvers<void>();
  const registry = createToolRegistry();
  const handler = vi.fn(async () => {
    if (options.outcome === "tool-error") throw new Error(READ_ERROR);
    return READ_OUTPUT;
  });
  let earlyWriteFailed = false;
  const savePart = store.savePart.bind(store);
  store.savePart = async (part: MessagePart) => {
    if (part.type === "tool" && part.callID === CALL_ID) {
      writes.push(part);
      const earlyWriteFailure = options.earlyWriteFailure ?? "running";
      if (!earlyWriteFailed && part.state.status === earlyWriteFailure) {
        earlyWriteFailed = true;
        earlyFailure.resolve();
        throw new Error(WRITE_ERROR);
      }
      if (
        earlyWriteFailed &&
        ((options.outcome === "pending-error" && part.state.status === "pending") ||
          (options.outcome === "running-error" && part.state.status === "running") ||
          (options.outcome === "result-error" && part.state.status === "completed"))
      )
        throw new Error(WRITE_ERROR);
    }
    await savePart(part);
  };
  registry.register({
    capability: "Read fixture for streaming persistence failures",
    inputSchema: {},
    outputSchema: { type: "string" },
    timeout: { kind: "none" },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Read cancelled" },
    permission: {
      permission: "read",
      reason: "Read fixture",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 1024, maxModelBytes: 1024, strategy: "inline" },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    metadata: {
      name: "StreamRead",
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler,
  });
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      mode: "yolo",
      modelStreaming: "on",
      titleGeneration: { enabled: false },
    },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as unknown as SessionStorePort,
      toolRegistry: registry,
      modelFactory: createTestModelFactory({
        async *streamText(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call", toolCall: { id: CALL_ID, name: "StreamRead", input: {} } };
            if (options.delayEarlySchedule) await scheduleStarted.promise;
            else if (options.earlyWriteFailure !== false) await earlyFailure.promise;
            if (options.streamFailure) throw new Error("Model request timed out.");
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      }),
    },
  );
  if (options.delayEarlySchedule) {
    const internal = runtime as unknown as AgentRuntimeInternal;
    const scheduleTools = internal.scheduleTools.bind(internal);
    vi.spyOn(internal, "scheduleTools").mockImplementationOnce(async (...args) => {
      scheduleStarted.resolve();
      await releaseSchedule.promise;
      return scheduleTools(...args);
    });
    const executeTools = internal.executeTools.bind(internal);
    vi.spyOn(internal, "executeTools").mockImplementation(async (...args) => {
      try {
        return await executeTools(...args);
      } finally {
        if (args[0].some((call) => call.id === CALL_ID)) lateExecutionSettled.resolve();
      }
    });
  }
  const parts = () =>
    store.savedParts.filter(
      (part): part is ToolPart => part.type === "tool" && part.callID === CALL_ID,
    );
  const hydrate = async () => {
    const history = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({ history, messages: await store.messages() });
    return buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages;
  };
  return {
    runtime,
    parts,
    writes,
    requests,
    handler,
    hydrate,
    releaseSchedule,
    lateExecutionSettled,
  };
}

function expectSingleRead(
  messages: readonly ModelInputMessage[],
  isError: boolean,
  content: string,
) {
  expect(
    messages.flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : [])),
  ).toEqual([{ id: CALL_ID, name: "StreamRead", input: {} }]);
  const results = messages.filter((message) => message.role === "tool");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolCallId: CALL_ID, isError });
  expect(JSON.stringify(results[0]?.content)).toContain(content);
}

describe("streaming tool attempt history", () => {
  it.each([
    { outcome: "success", status: "completed", isError: false, content: READ_OUTPUT, calls: 1 },
    { outcome: "tool-error", status: "error", isError: true, content: READ_ERROR, calls: 1 },
    {
      outcome: "pending-error",
      status: "pending",
      isError: true,
      content: INTERRUPTED_RESULT,
      calls: 0,
    },
    {
      outcome: "running-error",
      status: "pending",
      isError: true,
      content: INTERRUPTED_RESULT,
      calls: 0,
    },
    {
      outcome: "result-error",
      status: "running",
      isError: true,
      content: INTERRUPTED_RESULT,
      calls: 1,
    },
  ] as const)(
    "hydrates one call from separate attempts when fallback ends in $outcome",
    async ({ outcome, status, isError, content, calls }) => {
      const fixture = createFixture({ outcome });
      const turn = fixture.runtime.executeTurn("read a file");
      if (outcome.endsWith("-error") && outcome !== "tool-error") {
        await expect(turn).rejects.toBeDefined();
      } else {
        expect((await turn).response).toBe("done");
        expectSingleRead(fixture.requests[1]!.messages, isError, content);
      }
      expect(fixture.handler).toHaveBeenCalledTimes(calls);
      expect(fixture.parts()).toHaveLength(outcome === "pending-error" ? 1 : 2);
      expect(fixture.parts()[0]).toMatchObject({
        id: fixture.writes[0]!.id,
        declarationIndex: 0,
        state: { status: "pending" },
      });
      expect(fixture.parts().at(-1)).toMatchObject({
        declarationIndex: 0,
        state: { status },
      });
      expectSingleRead(await fixture.hydrate(), isError, content);
      expect(new Set(fixture.writes.map((part) => part.id)).size).toBe(2);
    },
  );

  it("persists fallback when the first pending write failed", async () => {
    const fixture = createFixture({ earlyWriteFailure: "pending" });
    expect((await fixture.runtime.executeTurn("read a file")).response).toBe("done");
    expect(fixture.handler).toHaveBeenCalledTimes(1);
    expect(fixture.parts()).toHaveLength(1);
    expect(fixture.parts()[0]?.id).not.toBe(fixture.writes[0]?.id);
    expectSingleRead(await fixture.hydrate(), false, READ_OUTPUT);
  });

  it("selects the new synthetic result after stream failure", async () => {
    const fixture = createFixture({ streamFailure: true });
    expect((await fixture.runtime.executeTurn("read a file")).response).toBe("done");
    expect(fixture.handler).not.toHaveBeenCalled();
    expect(fixture.parts()).toHaveLength(2);
    expect(fixture.parts().at(-1)?.id).not.toBe(fixture.writes[0]!.id);
    expect(fixture.parts().at(-1)).toMatchObject({
      state: { status: "error" },
    });
    expectSingleRead(fixture.requests[1]!.messages, true, "Side effects may be unknown");
    expectSingleRead(await fixture.hydrate(), true, "Side effects may be unknown");
  });

  it("selects synthetic recovery even after a late update to the earlier part", async () => {
    const fixture = createFixture({
      earlyWriteFailure: false,
      streamFailure: true,
      delayEarlySchedule: true,
    });
    try {
      expect((await fixture.runtime.executeTurn("read a file")).response).toBe("done");
      const recoveredPart = structuredClone(fixture.parts().at(-1));
      fixture.releaseSchedule.resolve();
      await fixture.lateExecutionSettled.promise;
      expect(fixture.parts().at(-1)).toEqual(recoveredPart);
      expect(fixture.parts().map((part) => part.state.status)).toEqual(["running", "error"]);
      expect(fixture.handler).not.toHaveBeenCalled();
      expectSingleRead(await fixture.hydrate(), true, "Side effects may be unknown");
    } finally {
      fixture.releaseSchedule.resolve();
    }
  });
});
