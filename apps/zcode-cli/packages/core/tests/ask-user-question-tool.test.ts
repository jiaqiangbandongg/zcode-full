import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type PermissionBrokerPort,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { createToolRegistry } from "../src/tool/registry.js";

describe("AskUserQuestion tool", () => {
  it("requests interaction even in yolo mode and returns model-friendly answers", async () => {
    const sessionId = createSessionId("ask-user-question");
    const turnId = createTurnId("ask-user-question");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("ask");
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const input = {
      questions: [
        {
          header: "Library",
          question: "Which date library should we use?",
          options: [
            { label: "date-fns", description: "Small functional helpers" },
            { label: "Luxon", description: "Richer timezone model" },
          ],
        },
        {
          header: "Runtime",
          question: "Which runtime should we target?",
          options: [
            { label: "Node", description: "Target Node.js" },
            { label: "Browser", description: "Target browsers" },
          ],
        },
      ],
    };
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        expect(request.toolName).toBe("AskUserQuestion");
        expect(request.sideEffectScope).toBe("userInteraction");
        return {
          decision: "modify",
          reason: "answered",
          modifiedInput: {
            ...request.input,
            answers: {
              "Which date library should we use?": "date-fns",
            },
          },
        };
      },
    };

    registry.register(askUserQuestionToolEntry);
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "yolo",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input,
        name: "AskUserQuestion",
      },
      { traceContext },
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      answers: {
        "Which date library should we use?": "date-fns",
      },
    });
    expect(result.modelContent).toContain("answered some questions and skipped 1");
    expect(result.modelContent).toContain('"Which date library should we use?"="date-fns"');
    expect(result.modelContent).toContain("best judgment for the unanswered questions");
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("treats an explicit empty answer map as a successful automatic continuation", async () => {
    const sessionId = createSessionId("ask-user-question-auto-resolved");
    const turnId = createTurnId("ask-user-question-auto-resolved");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        return {
          decision: "modify",
          reason: "auto_resolved_without_answer",
          modifiedInput: {
            ...(request.input as Record<string, unknown>),
            answers: {},
          },
        };
      },
    };
    registry.register(askUserQuestionToolEntry);
    const executor = createToolExecutor({
      emitEvent: async () => undefined,
      mode: "yolo",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("ask-auto-resolved"),
        input: {
          questions: [
            {
              header: "Library",
              question: "Which date library should we use?",
              options: [
                { label: "date-fns", description: "Small functional helpers" },
                { label: "Luxon", description: "Richer timezone model" },
              ],
            },
          ],
        },
        name: "AskUserQuestion",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ answers: {} });
    expect(result.modelContent).toContain("The user did not provide answers");
    expect(result.modelContent).not.toContain("response window ended");
    expect(result.modelContent).toContain("best judgment");
  });
});
