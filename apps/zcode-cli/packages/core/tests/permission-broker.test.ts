import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import type { PermissionBrokerRequest } from "@zcode/contracts";

describe("ManualPermissionBroker", () => {
  it("publishes a pending request and waits for client resolution", async () => {
    const request = createRequest();
    const seenRequests: PermissionBrokerRequest[] = [];
    const broker = createManualPermissionBroker({
      onRequest: (pending) => {
        seenRequests.push(pending);
      },
    });

    const pending = broker.requestPermission(request);
    expect(seenRequests).toEqual([request]);
    expect(broker.listPendingRequests()).toEqual([request]);

    const resolved = broker.resolvePermission(request.requestId, {
      decision: "allow",
      reason: "approved",
    });

    await expect(pending).resolves.toMatchObject({
      decision: "allow",
      reason: "approved",
    });
    expect(resolved).toBe(true);
    expect(broker.listPendingRequests()).toEqual([]);
  });

  it("cleans up pending requests on timeout", async () => {
    const request = createRequest();
    const broker = createManualPermissionBroker();
    const pending = broker.requestPermission(request, { timeoutMs: 1 });

    await expect(pending).rejects.toMatchObject({
      type: "permission_timeout",
    });
    expect(broker.listPendingRequests()).toEqual([]);
  });

  it("cleans up pending requests on cancellation", async () => {
    const request = createRequest();
    const broker = createManualPermissionBroker();
    const abortController = new AbortController();
    const pending = broker.requestPermission(request, { signal: abortController.signal });

    abortController.abort();

    await expect(pending).rejects.toMatchObject({
      type: "tool_cancelled",
    });
    expect(broker.listPendingRequests()).toEqual([]);
  });
});

function createRequest(): PermissionBrokerRequest {
  const sessionId = createSessionId("permission-broker");
  const turnId = createTurnId("permission-broker");
  const traceContext = createRootTraceContext({ sessionId, turnId });

  return {
    input: { command: "touch demo.txt" },
    mode: "build",
    reason: "Tool has side effects and requires approval",
    requestId: "perm_test",
    requestedAt: new Date(),
    riskLevel: "medium",
    ruleId: "mode.build.sideEffect",
    sessionId,
    sideEffectScope: "workspace",
    toolCallId: createToolCallId("broker"),
    toolName: "Bash",
    traceId: traceContext.traceId,
    turnId,
  };
}
