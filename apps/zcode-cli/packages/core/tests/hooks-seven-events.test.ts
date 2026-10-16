import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ExecutionPort,
  type ExecutionResult,
  type HookInput,
  type HookJSONOutput,
  type SessionEvent,
} from "@zcode/contracts";
import { createConfiguredHookRunner } from "../src/hooks/index.js";
import { matchesHookMatcher } from "../src/hooks/output.js";

const sessionId = createSessionId("hooks-seven-events");
const turnId = createTurnId("hooks-seven-events-turn");
const traceContext = createRootTraceContext({ sessionId, turnId });
const base = {
  agentName: "zcode",
  cwd: "/workspace",
  mode: "build" as const,
  sessionId,
  timestamp: "2026-07-10T00:00:00.000Z",
  traceId: traceContext.traceId,
  turnId,
};

type ConfiguredRunner = NonNullable<ReturnType<typeof createConfiguredHookRunner>>;

interface HookCase {
  event: HookEventName;
  expectedInput: Record<string, unknown>;
  input: HookInput;
  matcher: string;
  output: HookJSONOutput;
  verifyResult: (result: Awaited<ReturnType<ConfiguredRunner["run"]>>) => void;
}

const cases: HookCase[] = [
  {
    event: HookEventName.SessionStart,
    expectedInput: { model: "anthropic/opus", source: "startup" },
    input: {
      ...base,
      hookEventName: HookEventName.SessionStart,
      model: "anthropic/opus",
      source: "startup",
    },
    matcher: "startup",
    output: eventContext(HookEventName.SessionStart, "session-context"),
    verifyResult: (result) => expect(result.additionalContexts).toEqual(["session-context"]),
  },
  {
    event: HookEventName.UserPromptSubmit,
    expectedInput: { prompt: "ship hooks" },
    input: { ...base, hookEventName: HookEventName.UserPromptSubmit, prompt: "ship hooks" },
    matcher: "matcher-is-not-applied-to-prompt",
    output: eventContext(HookEventName.UserPromptSubmit, "prompt-context"),
    verifyResult: (result) => expect(result.additionalContexts).toEqual(["prompt-context"]),
  },
  {
    event: HookEventName.PreToolUse,
    expectedInput: {
      tool_input: { path: "a.ts" },
      tool_name: "Write",
      tool_use_id: "tool_hook-call",
    },
    input: toolInput(HookEventName.PreToolUse),
    matcher: "Write|Edit",
    output: {
      hookSpecificOutput: {
        additionalContext: "pre-context",
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: "allow",
        updatedInput: { path: "b.ts" },
      },
    },
    verifyResult: (result) => {
      expect(result.permissionBehavior).toBe("allow");
      expect(result.updatedInput).toEqual({ path: "b.ts" });
    },
  },
  {
    event: HookEventName.PermissionRequest,
    expectedInput: { reason: "write requires approval", requestId: "permission-1" },
    input: {
      ...toolInput(HookEventName.PermissionRequest),
      reason: "write requires approval",
      requestId: "permission-1",
    },
    matcher: "Write",
    output: {
      hookSpecificOutput: {
        decision: {
          behavior: "allow",
          updatedPermissions: [
            { type: "addRules", behavior: "allow", rules: [{ toolName: "Write" }] },
          ],
        },
        hookEventName: HookEventName.PermissionRequest,
      },
    },
    verifyResult: (result) => {
      expect(result.permissionRequestResult?.behavior).toBe("allow");
      expect(result.permissionRequestResult).toHaveProperty("updatedPermissions");
    },
  },
  {
    event: HookEventName.PostToolUse,
    expectedInput: { tool_response: { ok: true }, toolResultPreview: '{"ok":true}' },
    input: {
      ...toolInput(HookEventName.PostToolUse),
      toolResponse: { ok: true },
      toolResultPreview: '{"ok":true}',
    },
    matcher: "Write",
    output: eventContext(HookEventName.PostToolUse, "post-context"),
    verifyResult: (result) => expect(result.additionalContexts).toEqual(["post-context"]),
  },
  {
    event: HookEventName.PostToolUseFailure,
    expectedInput: { error: "cancelled", is_interrupt: true },
    input: {
      ...toolInput(HookEventName.PostToolUseFailure),
      error: { message: "cancelled", type: "TOOL_CANCELLED" },
      isInterrupt: true,
    },
    matcher: "Write",
    output: eventContext(HookEventName.PostToolUseFailure, "failure-context"),
    verifyResult: (result) => expect(result.additionalContexts).toEqual(["failure-context"]),
  },
  {
    event: HookEventName.Stop,
    expectedInput: { last_assistant_message: "draft answer", stop_hook_active: true },
    input: {
      ...base,
      hookEventName: HookEventName.Stop,
      responsePreview: "draft",
      responseText: "draft answer",
      stopHookActive: true,
      toolCallCount: 1,
    },
    matcher: "matcher-is-not-applied-to-response",
    output: { decision: "block", reason: "revise" },
    verifyResult: (result) => {
      expect(result.stopShouldContinue).toBe(true);
      expect(result.additionalContexts).toEqual(["revise"]);
    },
  },
];

describe("configured hooks seven-event contract", () => {
  it.each(cases)("runs $event with Claude-compatible input and output", async (hookCase) => {
    let capturedInput: Record<string, unknown> | undefined;
    let transcriptReadable = false;
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          [hookCase.event]: [
            {
              hooks: [{ type: "process", command: "hook-command" }],
              matcher: hookCase.matcher,
            },
          ],
        },
        maxOutputBytes: 4096,
        timeoutMs: 1000,
      },
      executionPort: executionPortReturning(hookCase.output, async (stdin) => {
        capturedInput = JSON.parse(stdin) as Record<string, unknown>;
        await readFile(String(capturedInput.transcript_path), "utf8");
        transcriptReadable = true;
      }),
      getWorkingDirectory: () => "/workspace",
    });

    const matchValue = getMatchValue(hookCase.input);
    const result = await runner!.run(
      hookCase.input,
      matchValue === undefined ? undefined : { matchValue },
    );

    expect(transcriptReadable).toBe(true);
    expect(capturedInput).toMatchObject({
      hook_event_name: hookCase.event,
      session_id: sessionId,
      transcript_path: expect.any(String),
      ...hookCase.expectedInput,
    });
    hookCase.verifyResult(result);
  });

  it("uses exact, pipe, wildcard, and regex hook matcher rules", () => {
    expect(matchesHookMatcher("Write", "Write")).toBe(true);
    expect(matchesHookMatcher("WriteFile", "Write")).toBe(false);
    expect(matchesHookMatcher("Edit", "Write|Edit")).toBe(true);
    expect(matchesHookMatcher("anything", "*")).toBe(true);
    expect(matchesHookMatcher("mcp__docs__read", "^mcp__.*__read$")).toBe(true);
    expect(matchesHookMatcher("Write", "[")).toBe(false);
  });

  it.each([
    {
      behavior: "deny",
      decision: { behavior: "deny" as const, message: "blocked by permission hook" },
      expected: { behavior: "deny", message: "blocked by permission hook" },
    },
    {
      behavior: "modify",
      decision: {
        behavior: "allow" as const,
        updatedInput: { path: "approved.ts" },
        updatedPermissions: [
          { type: "addRules" as const, behavior: "allow" as const, rules: [{ toolName: "Write" }] },
        ],
      },
      expected: { behavior: "allow", updatedInput: { path: "approved.ts" } },
    },
  ])("maps PermissionRequest $behavior decisions", async ({ decision, expected }) => {
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          PermissionRequest: [
            {
              hooks: [{ type: "process", command: "permission-hook" }],
              matcher: "Write",
            },
          ],
        },
        maxOutputBytes: 4096,
        timeoutMs: 1000,
      },
      executionPort: executionPortReturning(
        {
          hookSpecificOutput: {
            decision,
            hookEventName: HookEventName.PermissionRequest,
          },
        },
        async () => {},
      ),
      getWorkingDirectory: () => "/workspace",
    });

    const result = await runner!.run(cases[3]!.input, { matchValue: "Write" });

    expect(result.permissionRequestResult).toMatchObject(expected);
  });

  it("skips disabled hooks and accepts diagnostic or forward-compatible stdout", async () => {
    let callCount = 0;
    const outputs = ["plain diagnostic", JSON.stringify({ futureField: true })];
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          SessionStart: [
            {
              hooks: [
                { type: "process", command: "disabled", enabled: false },
                { type: "process", command: "diagnostic" },
                { type: "process", command: "future-output" },
              ],
            },
          ],
        },
        maxOutputBytes: 4096,
        timeoutMs: 1000,
      },
      executionPort: executionPortFrom(async () => completed(outputs[callCount++] ?? "")),
      getWorkingDirectory: () => "/workspace",
    });

    const result = await runner!.run(cases[0]!.input, { matchValue: "startup" });

    expect(callCount).toBe(2);
    expect(result.additionalContexts).toEqual([]);
  });

  it("backgrounds async command hooks and ignores their decisions", async () => {
    const gate = Promise.withResolvers<ExecutionResult>();
    const started = Promise.withResolvers<void>();
    const events: SessionEvent[] = [];
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "async-hook", async: true }] }],
        },
        maxOutputBytes: 4096,
        timeoutMs: 1000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: executionPortFrom(async () => {
        started.resolve();
        return gate.promise;
      }),
      getWorkingDirectory: () => "/workspace",
    });

    const result = await runner!.run(cases[0]!.input, { matchValue: "startup" });
    expect(result.additionalContexts).toEqual([]);
    await started.promise;
    gate.resolve(completed(JSON.stringify({ decision: "block", reason: "too late" })));
    await vi.waitFor(() => {
      expect(events.map((event) => event.type)).toContain(SessionEventType.HookRunCompleted);
    });
    expect(events.map((event) => event.type)).not.toContain(SessionEventType.HookRunBlocked);
  });

  it("cancels background async command hooks with the caller signal", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const events: SessionEvent[] = [];
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "async-hook", async: true }] }],
        },
        maxOutputBytes: 4096,
        timeoutMs: 1000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: executionPortFrom(async (_request, options) => {
        const signal = options?.signal;
        expect(signal).toBeDefined();
        started.resolve(signal!);
        return new Promise<ExecutionResult>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("execution aborted")), {
            once: true,
          });
        });
      }),
      getWorkingDirectory: () => "/workspace",
    });
    const controller = new AbortController();

    const result = await runner!.run(cases[0]!.input, {
      matchValue: "startup",
      signal: controller.signal,
    });
    expect(result.additionalContexts).toEqual([]);
    const executionSignal = await started.promise;
    controller.abort("turn cancelled");

    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.HookRunFailed,
          payload: expect.objectContaining({ outcome: "cancelled" }),
        }),
      );
    });
    expect(executionSignal.aborted).toBe(true);
  });
});

function getMatchValue(input: HookInput): string | undefined {
  if ("toolName" in input) return input.toolName;
  if (input.hookEventName === HookEventName.SessionStart) return input.source;
  return undefined;
}

function toolInput(
  event: typeof HookEventName.PreToolUse,
): Extract<HookInput, { hookEventName: "PreToolUse" }>;
function toolInput(
  event: typeof HookEventName.PermissionRequest,
): Omit<Extract<HookInput, { hookEventName: "PermissionRequest" }>, "reason" | "requestId">;
function toolInput(
  event: typeof HookEventName.PostToolUse,
): Omit<Extract<HookInput, { hookEventName: "PostToolUse" }>, "toolResponse" | "toolResultPreview">;
function toolInput(
  event: typeof HookEventName.PostToolUseFailure,
): Omit<Extract<HookInput, { hookEventName: "PostToolUseFailure" }>, "error">;
function toolInput(event: HookEventName): HookInput {
  return {
    ...base,
    hookEventName: event,
    riskLevel: "medium",
    sideEffectScope: "workspace",
    toolCallId: createToolCallId("hook-call"),
    toolInput: { path: "a.ts" },
    toolName: "Write",
  } as HookInput;
}

function eventContext(event: HookEventName, additionalContext: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext } as never };
}

function executionPortReturning(
  output: HookJSONOutput,
  capture: (stdin: string) => Promise<void>,
): ExecutionPort {
  return executionPortFrom(async (request) => {
    await capture(String(request.stdin));
    return completed(JSON.stringify(output));
  });
}

function executionPortFrom(run: ExecutionPort["run"]): ExecutionPort {
  return { run };
}

function completed(stdout: string): ExecutionResult {
  const now = new Date();
  return {
    cancelled: false,
    completedAt: now,
    durationMs: 1,
    exitCode: 0,
    startedAt: now,
    status: "completed",
    stderr: { bytes: 0, text: "", truncated: false },
    stdout: { bytes: Buffer.byteLength(stdout), text: stdout, truncated: false },
    timedOut: false,
  };
}
