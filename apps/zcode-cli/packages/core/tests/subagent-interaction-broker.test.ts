import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createToolCallId,
  createTurnId,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { createSubagentInteractionBroker } from "../src/runtime/helpers/subagent-interaction-broker.js";

describe("createSubagentInteractionBroker", () => {
  it("delegates subagent blocking interactions through the parent session", async () => {
    const parentSessionId = createSessionId("parent");
    const childSessionId = createSessionId("child");
    const parentTurnId = createTurnId("parent-turn");
    const childTurnId = createTurnId("child-turn");
    const parentToolCallId = createToolCallId("parent-agent");
    const childToolCallId = createToolCallId("child-tool");
    const delegated: Array<{
      options?: PermissionBrokerRequestOptions;
      request: PermissionBrokerRequest;
    }> = [];
    const parentBroker: PermissionBrokerPort = {
      requestPermission: vi.fn(async (request, options) => {
        delegated.push({ request, options });
        return { decision: "allow", reason: "parent approved" };
      }),
    };

    const broker = createSubagentInteractionBroker(parentBroker, {
      agentId: "agent_123",
      agentType: "general",
      childSessionId,
      description: "Inspect runtime behavior",
      parentSessionId,
      parentToolCallId,
      parentTurnId,
    });

    const toolNames = ["Bash", "AskUserQuestion", "ExitPlanMode"] as const;
    for (const toolName of toolNames) {
      await broker.requestPermission(
        {
          input: { prompt: "continue" },
          mode: toolName === "ExitPlanMode" ? "plan" : "build",
          reason: `${toolName} needs user input`,
          requestId: `req_${toolName}`,
          requestedAt: new Date(1),
          riskLevel: "medium",
          ruleId: `rule_${toolName}`,
          sessionId: childSessionId,
          toolCallId: childToolCallId,
          toolName,
          traceId: `trace_${toolName}` as never,
          turnId: childTurnId,
        },
        { timeoutMs: 1_000 },
      );
    }

    expect(parentBroker.requestPermission).toHaveBeenCalledTimes(toolNames.length);
    for (const { request, options } of delegated) {
      expect(options).toEqual({ timeoutMs: 1_000 });
      expect(request.sessionId).toBe(parentSessionId);
      expect(request.turnId).toBe(childTurnId);
      expect(request.toolCallId).toBe(childToolCallId);
      expect((request as { origin?: unknown }).origin).toEqual({
        kind: "subagent",
        agentId: "agent_123",
        agentType: "general",
        childSessionId,
        childTurnId,
        description: "Inspect runtime behavior",
        parentSessionId,
        parentToolCallId,
        parentTurnId,
      });
    }
  });

  // 2026-09-17 review：registered 必须显式转发，不能依赖恰好返回同一个 Promise 对象。
  it("forwards the parent broker's registered signal even when the result promise is re-wrapped", async () => {
    const registered = Promise.resolve();
    const parentBroker: PermissionBrokerPort = {
      requestPermission: () =>
        Object.assign(
          Promise.resolve<PermissionBrokerResult>({
            decision: "allow",
            reason: "ok",
          }),
          { registered },
        ),
    };
    const broker = createSubagentInteractionBroker(parentBroker, {
      agentId: "agent_registered",
      agentType: "general",
      childSessionId: createSessionId("child-registered"),
      description: "registered forwarding",
      parentSessionId: createSessionId("parent-registered"),
      parentToolCallId: createToolCallId("parent-registered"),
      parentTurnId: createTurnId("parent-turn-registered"),
    });
    const response = broker.requestPermission({
      input: {},
      mode: "guarded",
      reason: "needs approval",
      requestId: "req_registered",
      requestedAt: new Date(1),
      riskLevel: "high",
      sessionId: createSessionId("child-registered"),
      toolCallId: createToolCallId("child-registered"),
      toolName: "Bash",
      traceId: "trace_registered" as never,
    });
    expect(response.registered).toBe(registered);
    await expect(response).resolves.toEqual({
      decision: "allow",
      reason: "ok",
    });
  });
});
