import { expect, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  type ModelRequest,
  type ModelResult,
  type SessionId,
} from "@zcode/contracts";
import type { AgentProfile } from "../src/subagent/profile.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

export const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
export const done = (): ModelResult => ({ finishReason: "stop", text: "done", usage });
export const initial = (): AgentProfile => ({
  name: "reviewer",
  source: "user",
  description: "Review",
  tools: ["Read"],
  systemPrompt: "PROFILE_ORIGINAL",
  modelSelection: { providerId: "custom", modelId: "fixed", options: { reasoningLevel: "low" } },
});
export const spawn = (prompt: string, background = false) => ({
  id: `spawn_${prompt}`,
  name: "Agent",
  input: { description: prompt, prompt, subagent_type: "reviewer", run_in_background: background },
});
export const send = (id: string, message: string) => ({
  id: `send_${message}`,
  name: "SendMessage",
  input: { to: id, message, summary: message },
});
type Call = ReturnType<typeof spawn> | ReturnType<typeof send>;
export interface ChildRequest {
  sessionId: SessionId;
  model: string;
  reasoning: unknown;
  request: ModelRequest;
}

export function setup(onChild?: (record: ChildRequest) => Promise<ModelResult>) {
  const sessionId = createSessionId();
  const store = createRecordingSubagentSessionStore();
  const events = createTestSessionEventStore();
  const children: ChildRequest[] = [];
  const parents: ModelRequest[] = [];
  let profile = initial();
  let calls: Call[] = [],
    marker = "",
    sequence = 0,
    issued = false;
  const load = vi.fn(async () => ({ activeAgents: [profile] }));
  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
    {
      sessionStore: store,
      eventStore: events,
      loadAgentDefinitions: load,
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          if (observation.invocationContext?.metadata?.querySource === "subagent") {
            const record: ChildRequest = {
              sessionId: observation.invocationContext.traceContext!.sessionId!,
              model: observation.model.modelId,
              reasoning: observation.model.options.reasoningLevel,
              request: structuredClone(request),
            };
            children.push(record);
            return onChild ? onChild(record) : done();
          }
          parents.push(structuredClone(request));
          if (!issued && JSON.stringify(request.messages).includes(marker)) {
            issued = true;
            return { finishReason: "tool-calls", text: "", usage, toolCalls: calls };
          }
          return done();
        },
      }),
    },
  );
  const lifecycle = async (type: SessionEventType) =>
    (await events.getEvents(sessionId))
      .filter((event) => event.type === type)
      .map(
        (event) => event.payload as { agentId: string; childSessionId: SessionId; status: string },
      );
  return {
    store,
    runtime,
    events,
    parents,
    children,
    load,
    update(next: AgentProfile) {
      profile = next;
    },
    async turn(next: Call[]) {
      calls = next;
      marker = `PROFILE_FIELDS_TURN_${++sequence}`;
      issued = false;
      await runtime.executeTurn(marker);
      expect(issued).toBe(true);
    },
    spawned: () => lifecycle(SessionEventType.SubagentSpawned),
    async waitCompleted(id: string, count: number) {
      await vi.waitFor(async () =>
        expect(
          (await lifecycle(SessionEventType.SubagentStopped)).filter(
            (event) => event.agentId === id && event.status === "completed",
          ),
        ).toHaveLength(count),
      );
    },
  };
}

export function assertProfile(record: ChildRequest, profile: AgentProfile) {
  expect(record.model).toBe(profile.modelSelection!.modelId);
  expect(record.reasoning).toBe(profile.modelSelection!.options!.reasoningLevel);
  const system = record.request.messages.filter((m) => m.role === "system");
  expect(JSON.stringify(system)).toContain(profile.systemPrompt);
  expect(record.request.tools?.map((tool) => tool.name)).toEqual([
    ...profile.tools!,
    "RespondToCoordinator",
  ]);
}
