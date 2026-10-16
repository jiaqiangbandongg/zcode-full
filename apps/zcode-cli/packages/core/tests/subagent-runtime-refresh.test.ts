import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createTraceId,
  type ModelRequest,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { TurnPhase } from "../src/agent/turn-state.js";
import {
  createTurnAgentDefinitions,
  type AgentDefinitionsSnapshot,
} from "../src/subagent/definitions.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const snapshot = (version: string): AgentDefinitionsSnapshot => ({
  activeAgents: [
    {
      name: "researcher",
      description: "Research",
      source: "user",
      tools: ["Read"],
      systemPrompt: `PROFILE_${version}`,
      modelSelection: {
        providerId: "custom",
        modelId: version,
        options: { reasoningLevel: version === "old" ? "low" : "high" },
      },
    },
  ],
});
const call = (id: string) => ({
  id,
  name: "Agent",
  input: { description: "Research", prompt: "Read", subagent_type: "researcher" },
});

describe("subagent turn snapshot", () => {
  it("discards a cancelled load and retains independent immutable snapshots", async () => {
    const pending = Promise.withResolvers<AgentDefinitionsSnapshot>();
    const initial = snapshot("old");
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot("new"));
    const definitions = createTurnAgentDefinitions(() => initial, load);
    const other = createTurnAgentDefinitions(
      () => snapshot("other"),
      async () => snapshot("other"),
    );
    const controller = new AbortController();
    const traceContext = { sessionId: createSessionId(), traceId: createTraceId() };
    const cancelled = definitions.prepare({ signal: controller.signal, traceContext });
    controller.abort();
    pending.resolve(snapshot("cancelled"));
    await expect(cancelled).rejects.toThrow();
    expect(definitions.get().activeAgents[0]?.modelSelection?.modelId).toBe("old");
    await definitions.prepare({ signal: new AbortController().signal, traceContext });
    expect(definitions.get().activeAgents[0]?.modelSelection?.modelId).toBe("new");
    expect(other.get().activeAgents[0]?.modelSelection?.modelId).toBe("other");
  });

  it("freezes profile for the entire parent turn and reloads only on the next turn", async () => {
    let current = snapshot("old"),
      step = 0;
    const load = vi.fn(async () => current);
    const children: { model: string; reasoning: unknown; request: ModelRequest }[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(),
      { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        loadAgentDefinitions: load,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent") {
              children.push({
                model: observation.model.modelId,
                reasoning: observation.model.options.reasoningLevel,
                request,
              });
              current = snapshot("new");
              return { finishReason: "stop", text: "child done", usage };
            }
            const n = ++step;
            return n === 1 || n === 2 || n === 4
              ? { finishReason: "tool-calls", text: "", usage, toolCalls: [call(`call_${n}`)] }
              : { finishReason: "stop", text: "done", usage };
          },
        }),
      },
    );
    await runtime.executeTurn("first");
    expect(load).toHaveBeenCalledTimes(1);
    await runtime.executeTurn("second");
    expect(load).toHaveBeenCalledTimes(2);
    expect(children.map((x) => x.model)).toEqual(["old", "old", "new"]);
    expect(children.map((x) => x.reasoning)).toEqual(["low", "low", "high"]);
    expect(JSON.stringify(children[0]?.request)).toContain("PROFILE_old");
    expect(JSON.stringify(children[2]?.request)).toContain("PROFILE_new");
  });

  it("loads queued input only when it starts a new turn", async () => {
    let current = snapshot("old"),
      parentCalls = 0;
    const started = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const load = vi.fn(async () => current);
    const children: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(),
      { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        loadAgentDefinitions: load,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent") {
              children.push(observation.model.modelId);
              return { finishReason: "stop", text: "child", usage };
            }
            const step = ++parentCalls;
            if (step === 1) {
              started.resolve();
              await blocked.promise;
            }
            return step % 2
              ? { finishReason: "tool-calls", text: "", usage, toolCalls: [call(`queued_${step}`)] }
              : { finishReason: "stop", text: "done", usage };
          },
        }),
      },
    );
    const first = runtime.executeTurn("busy");
    await started.promise;
    const queued = runtime.executeTurn("queued");
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    current = snapshot("new");
    blocked.resolve();
    await Promise.all([first, queued]);
    expect(children).toEqual(["old", "new"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ends a failed configuration read without model requests and retries the next turn", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("config unavailable"))
      .mockResolvedValue(snapshot("new"));
    let calls = 0,
      children = 0;
    const requests: ModelRequest[] = [];
    const events = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtime = createTestAgentRuntime(
      createSessionId(),
      { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: true } },
      {
        eventStore: events,
        sessionStore,
        loadAgentDefinitions: load,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent") {
              children++;
              return { finishReason: "stop", text: "child", usage };
            }
            requests.push(request);
            return ++calls % 2
              ? { finishReason: "tool-calls", text: "", usage, toolCalls: [call(`call_${calls}`)] }
              : { finishReason: "stop", text: "done", usage };
          },
        }),
      },
    );
    await expect(runtime.executeTurn("CONFIG_FAILED_USER_INPUT")).rejects.toMatchObject({
      cause: { message: "config unavailable" },
    });
    expect(children).toBe(0);
    expect(requests).toHaveLength(0);
    const persisted = await sessionStore.messages({ sessionID: runtime.sessionId });
    expect(persisted.filter((message) => message.info.role === "user")).toHaveLength(1);
    expect(JSON.stringify(persisted)).toContain("CONFIG_FAILED_USER_INPUT");
    expect(
      (await events.getEvents(runtime.sessionId))
        .filter(
          (event) =>
            event.type === SessionEventType.TurnStarted ||
            event.type === SessionEventType.TurnError,
        )
        .map((event) => event.type),
    ).toEqual([SessionEventType.TurnStarted, SessionEventType.TurnError]);
    const failed = (await events.getEvents(runtime.sessionId)).filter(
      (event) => event.type === SessionEventType.TurnError,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ turnPhase: TurnPhase.ProcessingInput });
    expect(JSON.stringify(failed[0]!.payload)).toContain("config unavailable");
    await runtime.executeTurn("second");
    expect(children).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]!.messages).match(/CONFIG_FAILED_USER_INPUT/g)).toHaveLength(
      1,
    );
    expect(load).toHaveBeenCalledTimes(2);
  });
});
