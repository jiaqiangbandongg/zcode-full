import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EventReducer,
  InMemorySessionEventStore,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  type SessionStorePort,
  type SessionInfo,
  type MessageWithParts,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { createSubagentObservation } from "../../bootstrap/src/app/subagent-observation.js";

const parentId = createSessionId("parent");
const childId = createSessionId("subagent_agent1");
const baseSession = { time: { created: 1, updated: 2 }, taskType: "subagent_child" };

async function observationFixture() {
  const events = new InMemorySessionEventStore();
  const parent = { ...baseSession, id: parentId } as SessionInfo;
  const child = { ...baseSession, id: childId, parentID: parentId } as SessionInfo;
  const parentMessages = [
    {
      info: { role: "assistant", id: "parent-msg", time: { created: 1 } },
      parts: [
        {
          type: "tool",
          tool: "Agent",
          callID: "launch",
          state: {
            status: "completed",
            input: { description: "Inspect auth", run_in_background: true },
            output: JSON.stringify({ agentId: "agent1", childSessionId: childId }),
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ] as unknown as MessageWithParts[];
  const childMessages = [
    {
      info: { role: "assistant", id: "answer", time: { created: 3 } },
      parts: [{ id: "text", type: "text", text: "persisted answer" }],
    },
  ] as unknown as MessageWithParts[];
  const store = {
    getSession: async (id: string) =>
      id === parentId ? parent : id === childId ? child : undefined,
    messages: async ({ sessionID }: { sessionID: string }) =>
      sessionID === parentId ? parentMessages : childMessages,
  } as unknown as SessionStorePort;
  const runtime = {
    getSessionEventStore: () => events,
    getProjection: async () => new EventReducer().reduce(await events.getEvents(parentId)),
  } as unknown as AgentRuntime;
  const app = createSubagentObservation({ runtime, sessionId: parentId, sessionStore: store });
  return { app, events, child, childMessages, parentMessages };
}

test("directory uses child lifecycle, not the completed parent Agent launch ACK", async () => {
  const f = await observationFixture();
  await f.events.append(createSessionEvent(SessionEventType.TurnStarted, childId, {}));
  await f.events.append(
    createSessionEvent(SessionEventType.SubagentSpawned, parentId, {
      childSessionId: childId,
      agentId: "agent1",
      agentType: "Explore",
      parentToolCallId: "launch",
    }),
  );
  let directory = await f.app.readSubagents();
  assert.equal(directory.running.length, 1);
  assert.equal(directory.ended.total, 0);
  await f.events.append(createSessionEvent(SessionEventType.TurnComplete, parentId, {}));
  directory = await f.app.readSubagents();
  assert.equal(directory.running.length, 1);
  await f.events.append(createSessionEvent(SessionEventType.TurnComplete, childId, {}));
  directory = await f.app.readSubagents();
  assert.equal(directory.running.length, 0);
  assert.equal(directory.ended.items[0].status, "success");
});

test("transcript snapshot replaces retained streaming messages and preserves cold persisted output", async () => {
  const f = await observationFixture();
  let snapshot = await f.app.readSubagentTranscript(childId);
  assert.equal(snapshot.messages[0].content, "persisted answer");
  await f.events.append(
    createSessionEvent(SessionEventType.ModelStreaming, childId, {
      kind: "start",
      assistantMessageId: "answer",
    }),
  );
  await f.events.append(
    createSessionEvent(SessionEventType.ModelStreaming, childId, {
      kind: "text_delta",
      assistantMessageId: "answer",
      delta: "live answer",
    }),
  );
  snapshot = await f.app.readSubagentTranscript(childId);
  assert.equal(snapshot.messages[0].content, "");
  assert.deepEqual(snapshot.replayMessageIds, ["answer"]);
  assert.equal(snapshot.sequenceNumber, 2);
  await assert.rejects(() => f.app.readSubagentTranscript(parentId), /does not belong/);
  f.child.parentID = createSessionId("other");
  await assert.rejects(() => f.app.readSubagentTranscript(childId), /does not belong/);
});
