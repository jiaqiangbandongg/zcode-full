import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  HookEventName,
  type CollaborationMode,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { PermissionService } from "../src/permission/service.js";

function harness(mode: CollaborationMode, hookFailure = false) {
  const sessionId = createSessionId("permission-log-session");
  const turnId = createTurnId("permission-log-turn");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const toolCallId = createToolCallId("permission-log-call");
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  const registry = createToolRegistry();
  const handler = vi.fn(async () => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    interrupted: false,
  }));
  registry.register({ ...bashToolEntry, handler });
  const response = Promise.withResolvers<PermissionBrokerResult>();
  const requestPermission = vi.fn(() => response.promise);
  const executor = createToolExecutor({
    registry,
    mode,
    sessionId,
    turnId,
    traceContext,
    logger,
    permissionService: new PermissionService(),
    permissionBroker: { requestPermission },
    emitEvent: async () => {},
    bashShellSelection: { dialect: "posix", source: "auto-detected", display: { name: "bash" } },
    hookRunner: {
      run: async (input) => {
        if (hookFailure && input.hookEventName === HookEventName.PermissionRequest)
          throw new Error("hook unavailable");
        return { additionalContexts: [] };
      },
    },
  });
  return {
    logger,
    handler,
    response,
    requestPermission,
    context: {
      traceId: traceContext.traceId,
      sessionId,
      turnId,
      toolCallId,
      toolName: "Bash",
      module: "core.tool.executor",
    },
    execute: () =>
      executor.execute({
        id: toolCallId,
        name: "Bash",
        input: { command: "rm -rf private-input" },
      }),
  };
}

describe("permission lifecycle log compatibility", () => {
  it.each(["yolo", "plan"] as const)(
    "keeps evaluated and policy denial fields in %s",
    async (mode) => {
      const h = harness(mode);
      const result = await h.execute();
      expect(h.logger.debug).toHaveBeenCalledWith(
        "Tool permission evaluated",
        expect.objectContaining({
          ...h.context,
          mode,
          event: "tool.permission.evaluated",
          decision: mode === "yolo" ? "allow" : "deny",
          status: mode === "yolo" ? "completed" : "failed",
          riskLevel: "high",
          sideEffectScope: "system",
          reason: expect.any(String),
          ruleId: expect.any(String),
          inputSummary: { type: "object", keys: ["command"] },
        }),
      );
      const evaluated = h.logger.debug.mock.calls.find(
        ([message]) => message === "Tool permission evaluated",
      );
      expect(JSON.stringify(evaluated)).not.toContain("private-input");
      if (mode === "plan")
        expect(h.logger.warn).toHaveBeenCalledWith(
          "Tool permission denied",
          expect.objectContaining({
            ...h.context,
            mode,
            event: "tool.permission.denied",
            decision: "deny",
            status: "failed",
            reason: expect.any(String),
            ruleId: expect.any(String),
          }),
        );
      expect(result.success).toBe(mode === "yolo");
      expect(h.handler).toHaveBeenCalledTimes(mode === "yolo" ? 1 : 0);
      expect(h.requestPermission).not.toHaveBeenCalled();
    },
  );

  it.each(["build", "guarded"] as const)(
    "logs each %s broker outcome once with its request and trace",
    async (mode) => {
      for (const decision of ["allow", "deny"] as const) {
        const h = harness(mode);
        const pending = h.execute();
        await vi.waitFor(() => expect(h.requestPermission).toHaveBeenCalledOnce());
        h.response.resolve({ decision, reason: "explicit test response" });
        const result = await pending;
        expect(h.logger.debug).toHaveBeenCalledWith(
          "Tool permission evaluated",
          expect.objectContaining({
            ...h.context,
            event: "tool.permission.evaluated",
            decision: "ask",
            status: "waiting",
          }),
        );
        const resolved = h.logger.info.mock.calls.filter(
          ([message]) => message === "Tool permission resolved",
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.[1]).toMatchObject({
          ...h.context,
          mode,
          event: "tool.permission.resolved",
          requestId: expect.stringMatching(/^perm_/),
          decision,
          reason: "explicit test response",
          status: decision === "allow" ? "completed" : "failed",
        });
        expect(result.success).toBe(decision === "allow");
        expect(h.handler).toHaveBeenCalledTimes(decision === "allow" ? 1 : 0);
      }
    },
  );

  it("retains hook failure correlation while waiting for the actual broker", async () => {
    const h = harness("build", true);
    const pending = h.execute();
    try {
      await vi.waitFor(() =>
        expect(h.logger.warn).toHaveBeenCalledWith(
          "PermissionRequest hook chain failed; waiting for client decision",
          expect.objectContaining({
            ...h.context,
            event: "tool.permission.hook_race_forfeited",
            status: "waiting",
            requestId: expect.stringMatching(/^perm_/),
            errorMessage: "hook unavailable",
          }),
        ),
      );
      expect(h.handler).not.toHaveBeenCalled();
    } finally {
      h.response.resolve({ decision: "allow" });
      await pending;
    }
    expect((await pending).success).toBe(true);
    expect(h.handler).toHaveBeenCalledOnce();
  });
});
