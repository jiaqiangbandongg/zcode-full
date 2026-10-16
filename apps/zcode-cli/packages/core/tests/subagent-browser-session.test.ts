import { describe, expect, it, vi } from "vitest";
import { createSessionId, type BrowserControlPort } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { done, initial, spawn, usage } from "./subagent-profile-scenario.js";

function createPorts() {
  const childPort: BrowserControlPort = {
    list: vi.fn(async () => []),
    execute: vi.fn(async () => ({ ok: true as const, elapsedMs: 0 })),
    turnEnded: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
  };
  const parentPort: BrowserControlPort = {
    list: vi.fn(async () => []),
    execute: vi.fn(async () => ({ ok: true as const, elapsedMs: 0 })),
    turnEnded: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    forChildSession: vi.fn(() => childPort),
  };
  return { childPort, parentPort };
}

async function runParentWithChild(browserControlPort: BrowserControlPort) {
  const sessionId = createSessionId();
  const childSessionIds: string[] = [];
  let issued = false;
  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
    {
      browserControlPort,
      sessionStore: createRecordingSubagentSessionStore(),
      eventStore: createTestSessionEventStore(),
      loadAgentDefinitions: vi.fn(async () => ({ activeAgents: [initial()] })),
      modelFactory: createTestModelFactory({
        async generateText(_request, observation) {
          if (observation.invocationContext?.metadata?.querySource === "subagent") {
            childSessionIds.push(observation.invocationContext.traceContext!.sessionId!);
            return done();
          }
          if (issued) return done();
          issued = true;
          return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("BROWSE")] };
        },
      }),
    },
  );
  try {
    await runtime.executeTurn("START");
  } finally {
    runtime.beginShutdown();
  }
  return { sessionId, childSessionId: childSessionIds[0]! };
}

describe("subagent Browser Use session", () => {
  it("以父会话为 tab 归属登记子会话，子代理结束时经子端口撤销登记", async () => {
    const { childPort, parentPort } = createPorts();

    const { sessionId, childSessionId } = await runParentWithChild(parentPort);

    expect(childSessionId).toBeDefined();
    expect(childSessionId).not.toBe(sessionId);
    expect(parentPort.forChildSession).toHaveBeenCalledWith({
      childSessionId,
      parentSessionId: sessionId,
      tabOwner: "parent",
    });
    expect(childPort.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: childSessionId }),
    );
    expect(parentPort.closeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: childSessionId }),
    );
  });

  it("端口没有 forChildSession 时直接用父端口关闭子会话自己的 session", async () => {
    const { parentPort } = createPorts();
    delete parentPort.forChildSession;

    const { childSessionId } = await runParentWithChild(parentPort);

    expect(parentPort.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: childSessionId }),
    );
  });
});
