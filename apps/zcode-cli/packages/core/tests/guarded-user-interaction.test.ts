import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createToolCallId,
  SessionEventType,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { PermissionService } from "../src/permission/service.js";

const QUESTION = "Which color should we use?";
const INPUT = {
  questions: [
    {
      header: "Color",
      question: QUESTION,
      options: [
        { label: "Blue", description: "Use blue" },
        { label: "Red", description: "Use red" },
      ],
    },
  ],
};

async function runQuestion(options: {
  mode?: CollaborationMode;
  answers?: unknown;
  deny?: boolean;
  hookAnswers?: boolean;
}) {
  const registry = createToolRegistry();
  const handler = vi.fn(askUserQuestionToolEntry.handler);
  registry.register({ ...askUserQuestionToolEntry, handler });
  const requests: PermissionBrokerRequest[] = [];
  const events: SessionEvent[] = [];
  let permissionHookCalls = 0;
  const executor = createToolExecutor({
    mode: options.mode ?? "guarded",
    sessionId: createSessionId("guarded-question"),
    registry,
    permissionService: new PermissionService(),
    emitEvent: async (event) => {
      events.push(event);
    },
    permissionBroker: {
      async requestPermission(request, requestOptions): Promise<PermissionBrokerResult> {
        requests.push(request);
        // 有界失败：回归时立即报错，不让重复问答把测试挂死。
        if (requests.length > (options.hookAnswers ? 2 : 1)) {
          throw new Error("User answer must not reopen the interaction");
        }
        if (options.hookAnswers && requests.length === 1) {
          return new Promise((_, reject) => {
            requestOptions!.signal!.addEventListener("abort", () => reject(new Error("Hook won")), {
              once: true,
            });
          });
        }
        return options.deny
          ? { decision: "deny", reason: "No answer" }
          : { decision: "modify", modifiedInput: { ...INPUT, answers: options.answers } };
      },
    },
    ...(options.hookAnswers
      ? {
          hookRunner: {
            run: async ({ hookEventName }) => {
              if (hookEventName === "PermissionRequest") permissionHookCalls++;
              return {
                additionalContexts: [],
                ...(hookEventName === "PermissionRequest" && requests.length === 1
                  ? {
                      permissionRequestResult: {
                        behavior: "allow" as const,
                        updatedInput: { ...INPUT, answers: { [QUESTION]: "Hook answer" } },
                      },
                    }
                  : {}),
              };
            },
          },
        }
      : {}),
  });
  const result = await executor.execute({
    id: createToolCallId("guarded-question"),
    name: "AskUserQuestion",
    input: INPUT,
  });
  return { result, requests, events, handler, permissionHookCalls };
}

describe.each(["yolo", "guarded"] as const)("%s user interaction completion", (mode) => {
  it.each(["Blue", "Custom teal", undefined])(
    "returns %s without reopening the question",
    async (answer) => {
      const answers = answer === undefined ? {} : { [QUESTION]: answer };
      const { result, requests, events, handler } = await runQuestion({ mode, answers });
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ answers });
      expect(result.modelContent).toContain(answer ?? "The user did not provide answers");
      expect(requests).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).toEqual([
        SessionEventType.PermissionRequested,
        SessionEventType.PermissionResolved,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallResult,
      ]);
    },
  );

  it("still rejects invalid answers before the handler", async () => {
    const { result, requests, handler } = await runQuestion({ mode, answers: 42 });
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("still respects user denial", async () => {
    const { result, requests, handler } = await runQuestion({ mode, deny: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("No answer");
    expect(requests).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });
});

it("rechecks Hook changes instead of treating them as a user's answer", async () => {
  const answers = { [QUESTION]: "Real user answer" };
  const { result, requests, handler, permissionHookCalls } = await runQuestion({
    answers,
    hookAnswers: true,
  });
  expect(result.success).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
  expect(result.output).toMatchObject({ answers });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(permissionHookCalls).toBe(1);
});
