import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  type MessagePart,
  type ModelInputMessage,
  type SessionStorePort,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";

const CALL_IDS = ["settlement-first", "settlement-second", "settlement-third"];
const OUTPUTS = ["first output", "second output", "third output"];
const IMAGE_DATA = "data:image/png;base64,c2V0dGxlbWVudA==";
const IMAGE_CONTENT = [{ type: "image" as const, mediaType: "image/png", dataUrl: IMAGE_DATA }];
const INTERRUPTED_RESULT = "[Tool execution was interrupted before resume]";
type Failure = "part" | "media" | "usage";

function createFixture(
  options: { failure?: Failure; image?: boolean; blockSiblings?: boolean } = {},
) {
  const sessionId = createSessionId("tool-result-settlement");
  const failure = new Error(`injected ${options.failure} persistence failure`);
  const store = {
    ...createRecordingMessageStore(),
    async getProjectPermission() {
      return null;
    },
  };
  const eventStore = createTestSessionEventStore();
  const firstCompleted = Promise.withResolvers<void>();
  const siblingsStarted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const requests: Array<readonly ModelInputMessage[]> = [];
  const registry = createToolRegistry();
  const artifacts = new Map<string, string>();
  let injectFailure = Boolean(options.failure);
  const savePart = store.savePart.bind(store);
  store.savePart = async (part: MessagePart) => {
    if (
      injectFailure &&
      options.failure === "part" &&
      part.type === "tool" &&
      part.callID === CALL_IDS[1] &&
      part.state.status === "completed"
    )
      throw failure;
    await savePart(part);
  };
  const append = eventStore.append.bind(eventStore);
  vi.spyOn(eventStore, "append").mockImplementation(async (event) => {
    if (
      injectFailure &&
      options.failure === "usage" &&
      event.type === SessionEventType.ModelComplete &&
      (event.payload as { stopReason?: string }).stopReason === "tool_internal"
    )
      throw failure;
    const stored = await append(event);
    if (
      event.type === SessionEventType.ToolCallResult &&
      (event.payload as { toolCallId?: string }).toolCallId === CALL_IDS[0]
    )
      firstCompleted.resolve();
    return stored;
  });
  const writeArtifact = vi.fn<ToolArtifactStorePort["writeToolResultArtifact"]>(
    async (request, writeOptions) => {
      if (writeOptions?.signal?.aborted) throw writeOptions.signal.reason;
      if (injectFailure && options.failure === "media") throw failure;
      const uri = `zcode-artifact://settlement/${artifacts.size}`;
      artifacts.set(uri, request.content);
      return {
        id: uri,
        uri,
        path: uri,
        bytes: request.content.length,
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(),
      };
    },
  );
  const artifactStore: ToolArtifactStorePort = {
    writeToolResultArtifact: writeArtifact,
    async readToolResultArtifact({ uri }) {
      const content = artifacts.get(uri);
      if (!content) throw new Error(`Missing artifact ${uri}`);
      return { uri, content, bytes: content.length, contentType: "text/plain" };
    },
  };
  const handlers = CALL_IDS.map((id, index) => {
    const handler = vi.fn(async (_input, context) => {
      if (options.blockSiblings && index > 0) {
        siblingsStarted[index - 1]!.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (context.abortSignal.aborted) reject(context.abortSignal.reason);
          else
            context.abortSignal.addEventListener(
              "abort",
              () => reject(context.abortSignal.reason),
              { once: true },
            );
        });
      }
      return options.failure === "usage" && index === 0
        ? { text: OUTPUTS[index], modelUsage: { inputTokens: 1, outputTokens: 1 } }
        : OUTPUTS[index];
    });
    registry.register({
      inputSchema: {},
      metadata: {
        name: `Read${index}`,
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler,
      ...(options.image && index === 0 ? { formatModelContent: () => IMAGE_CONTENT } : {}),
    });
    return handler;
  });
  const modelFactory = createTestModelFactory({
    async generateText(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: CALL_IDS.map((id, index) => ({ id, name: `Read${index}`, input: {} })),
        };
      return { text: "done", finishReason: "stop", usage: {} };
    },
  });
  const buildRuntime = (events = eventStore) =>
    createTestAgentRuntime(
      sessionId,
      { mode: "yolo", modelStreaming: "off", titleGeneration: { enabled: false } },
      {
        eventStore: events,
        sessionStore: store as unknown as SessionStorePort,
        artifactStore,
        toolRegistry: registry,
        modelFactory,
      },
    );
  return {
    runtime: buildRuntime(),
    requests,
    handlers,
    failure,
    store,
    writeArtifact,
    readyToStop: () =>
      Promise.all([firstCompleted.promise, ...siblingsStarted.map((item) => item.promise)]),
    recoverStorage: () => {
      injectFailure = false;
    },
    async durableCallIds() {
      const events = await eventStore.getEvents(sessionId);
      return {
        anchors: events
          .filter((event) => event.type === SessionEventType.StreamRecoveryAnchorCreated)
          .map((event) => (event.payload as { toolCallId: string }).toolCallId),
        committed: events
          .filter(
            (event) =>
              event.type === SessionEventType.StreamingToolLedgerUpdated &&
              (event.payload as { status: string }).status === "tool_result_committed",
          )
          .map((event) => (event.payload as { toolCallId: string }).toolCallId),
      };
    },
    async coldResume() {
      const resumed = buildRuntime(createTestSessionEventStore());
      await resumed.resumeFromStore();
      await resumed.executeTurn("continue after restart");
      return requests.at(-1)!;
    },
  };
}

function pairedResults(messages: readonly ModelInputMessage[]) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  const results = messages.filter((message) => message.role === "tool");
  expect(calls.map((call) => call.id)).toEqual(CALL_IDS);
  expect(results.map((result) => result.toolCallId)).toEqual(CALL_IDS);
  return results;
}

describe("runtime tool result settlement", () => {
  it.each<Failure>(["part", "media", "usage"])(
    "retains the whole batch after %s persistence fails",
    async (failure) => {
      const fixture = createFixture({ failure, image: failure === "media" });
      await expect(fixture.runtime.executeTurn("run tools")).rejects.toMatchObject({
        cause: fixture.failure,
      });
      expect(fixture.requests).toHaveLength(1);
      const durableIds = failure === "part" ? [CALL_IDS[0]] : [];
      expect(await fixture.durableCallIds()).toEqual({
        anchors: durableIds,
        committed: durableIds,
      });
      fixture.recoverStorage();
      await expect(fixture.runtime.executeTurn("continue after recovery")).resolves.toMatchObject({
        response: "done",
      });
      const results = pairedResults(fixture.requests[1]!);
      expect(results.every((result) => !result.isError)).toBe(true);
      if (failure === "media") expect(results[0]!.content).toEqual(IMAGE_CONTENT);
      else expect(JSON.stringify(results[0]!.content)).toContain(OUTPUTS[0]);
      expect(results.slice(1).map((result) => result.content)).toEqual(OUTPUTS.slice(1));
      for (const handler of fixture.handlers) expect(handler).toHaveBeenCalledTimes(1);
      expect(await fixture.durableCallIds()).toEqual({
        anchors: durableIds,
        committed: durableIds,
      });
      if (failure === "part") {
        const cold = pairedResults(await fixture.coldResume());
        expect(cold[0]!.content).toBe(OUTPUTS[0]);
        expect(cold.slice(1).map((result) => [result.isError, result.content])).toEqual([
          [true, INTERRUPTED_RESULT],
          [true, INTERRUPTED_RESULT],
        ]);
        for (const handler of fixture.handlers) expect(handler).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves successful image and cancelled siblings across Stop and cold resume", async () => {
    const fixture = createFixture({ image: true, blockSiblings: true });
    const controller = new AbortController();
    const turn = fixture.runtime.executeTurn("read image and siblings", undefined, {
      abortSignal: controller.signal,
    });
    const rejection = expect(turn).rejects.toMatchObject({ type: "turn_cancelled" });
    try {
      await fixture.readyToStop();
      controller.abort(new Error("user stop"));
      await rejection;
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.writeArtifact).toHaveBeenCalledTimes(1);
      expect(await fixture.durableCallIds()).toEqual({ anchors: CALL_IDS, committed: CALL_IDS });
      await fixture.runtime.executeTurn("continue after stop");
      const live = pairedResults(fixture.requests[1]!);
      expect(live[0]).toMatchObject({ content: IMAGE_CONTENT, isError: false });
      expect(live.slice(1).every((result) => result.isError)).toBe(true);
      const cold = pairedResults(await fixture.coldResume());
      expect(cold[0]).toMatchObject({ content: IMAGE_CONTENT, isError: false });
      expect(cold.slice(1).every((result) => result.isError)).toBe(true);
      for (const handler of fixture.handlers) expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort(new Error("test cleanup"));
      await turn.catch(() => undefined);
    }
  });
});
