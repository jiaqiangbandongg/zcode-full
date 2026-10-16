import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  type PermissionBrokerRequest,
  type SessionEvent,
} from "@zcode/contracts";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

describe("guarded real subagent ingress", () => {
  it.each([
    ["Explore", false],
    ["general-purpose", false],
    ["custom", false],
    ["general-purpose", true],
  ] as const)(
    "%s routes a real pending request to its parent (background=%s)",
    async (agentType, background) => {
      const requests: PermissionBrokerRequest[] = [];
      const execute = vi.fn(async () => {
        throw new Error("Must not execute");
      });
      let mainCalls = 0;
      let childCalls = 0;
      const childModelRequests: string[] = [];
      const eventStore = createTestSessionEventStore();
      const parentEvents: SessionEvent[] = [];
      const broker = createManualPermissionBroker({
        onRequest: (request) => {
          requests.push(request);
        },
      });
      const sessionId = createSessionId("guarded-parent");
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "guarded",
          workingDirectory: "/workspace/guarded-fixture",
          bashShellSelection: {
            dialect: "posix",
            source: "auto-detected",
            display: { name: "bash" },
          },
          subagents: {
            profiles: [
              {
                name: "custom",
                description: "custom",
                source: "user",
                tools: ["Bash"],
                systemPrompt: "test",
                permissionMode: "bypassPermissions",
              },
            ],
          },
        },
        {
          eventStore,
          executionPort: { run: execute },
          permissionBroker: {
            requestPermission: (request, options) =>
              broker.requestPermission(request, { ...options, timeoutMs: 3000 }),
          },
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              const child =
                (observation.invocationContext?.metadata as { querySource?: string })
                  ?.querySource === "subagent";
              const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
              if (child) childModelRequests.push(JSON.stringify(request));
              if (child && ++childCalls === 1)
                return {
                  finishReason: "tool-calls",
                  text: "",
                  usage,
                  toolCalls: [
                    { id: "guarded-child-rm", name: "Bash", input: { command: "rm -rf fixture" } },
                  ],
                };
              if (!child && ++mainCalls === 1)
                return {
                  finishReason: "tool-calls",
                  text: "",
                  usage,
                  toolCalls: [
                    {
                      id: "guarded-agent",
                      name: "Agent",
                      input: {
                        description: "test",
                        prompt: "test",
                        subagent_type: agentType,
                        run_in_background: background,
                      },
                    },
                  ],
                };
              return { finishReason: "stop", text: "done", usage };
            },
          }),
        },
      );
      const unsubscribe = runtime.subscribeEvents({
        onSessionEvent: (event) => {
          if (event.sessionId === sessionId) parentEvents.push(event);
        },
      });
      const turn = runtime.executeTurn("Run the fixture child");
      await vi.waitFor(async () => {
        expect(requests).toHaveLength(1);
        expect(
          parentEvents.some((event) => event.type === SessionEventType.PermissionRequested),
        ).toBe(true);
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        mode: "guarded",
        approvalMode: "user-once",
        sessionId,
        origin: { kind: "subagent" },
      });
      expect(execute).not.toHaveBeenCalled();
      const id = requests[0]!.requestId;
      expect(broker.listPendingRequests()).toHaveLength(1);
      expect(broker.resolvePermission(id, { decision: "deny", reason: "test denied" })).toBe(true);
      expect(broker.resolvePermission(id, { decision: "allow" })).toBe(false);
      await turn;
      await vi.waitFor(() =>
        expect(childModelRequests.some((request) => request.includes("test denied"))).toBe(true),
      );
      expect(
        parentEvents.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(1);
      expect(broker.listPendingRequests()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      unsubscribe();
    },
  );
});
