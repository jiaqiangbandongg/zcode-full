import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  type SessionGoal,
  type SessionStorePort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime turn cancellation", () => {
  // Bugfix 回归：用户主动取消（TurnCancelled）属于正常结束，事件流应以 TurnComplete(cancelled)
  // 结尾、绝不出现 TurnError，避免被下游映射成 turn.failed。
  it("emits TurnComplete(cancelled) instead of TurnError when the turn is aborted", async () => {
    const sessionId = createSessionId("runtime-cancel-turn");
    const eventStore = createTestSessionEventStore();
    const abortController = new AbortController();

    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a cancel test agent." },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            // 模拟用户在模型请求进行中按下取消。
            abortController.abort(new Error("user cancelled"));
            throw new Error("user cancelled");
          },
        } as never),
      },
    );

    await expect(
      runtime.executeTurn("do something long", undefined, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const events = await eventStore.getEvents(sessionId);
    const types = events.map((event) => event.type);

    expect(types).not.toContain(SessionEventType.TurnError);
    expect(types[types.length - 1]).toBe(SessionEventType.TurnComplete);

    const completeEvent = events[events.length - 1];
    expect((completeEvent.payload as { resultType?: string }).resultType).toBe("cancelled");
  });

  it("keeps a cancelled goal paused when resuming the session", async () => {
    const sessionId = createSessionId("runtime-cancel-paused-goal-resume");
    let target: SessionGoal = {
      sessionID: sessionId,
      targetID: "target-paused" as never,
      objective: "Ship the paused goal",
      summaryTitle: null,
      status: "paused",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      time: {
        created: 1,
        updated: 1,
      },
    };
    let updateTargetStatusCalls = 0;
    const sessionStore = {
      async readTarget() {
        return target;
      },
      async updateTargetStatus(input: { status: SessionGoal["status"] }) {
        updateTargetStatusCalls += 1;
        target = {
          ...target,
          status: input.status,
          time: {
            ...target.time,
            updated: target.time.updated + 1,
          },
        };
        return target;
      },
    } as unknown as SessionStorePort;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore,
      },
    );

    const resumedTarget = await runtime.activatePausedTargetAfterResume(
      createRootTraceContext({ sessionId }),
    );

    expect(resumedTarget).toMatchObject({ status: "paused" });
    expect(updateTargetStatusCalls).toBe(0);
    await expect(sessionStore.readTarget({ sessionID: sessionId })).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("rejects a cancelled queued prompt before the active turn finishes", async () => {
    const sessionId = createSessionId("runtime-cancel-queued-prompt");
    const firstModelStarted = deferred<void>();
    const firstModelCanFinish = deferred<void>();
    const abortController = new AbortController();
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a command queue cancellation test agent." },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount += 1;
            if (modelCallCount === 1) {
              firstModelStarted.resolve();
              await firstModelCanFinish.promise;
              return modelTextResult("first complete");
            }
            return modelTextResult("second should not start");
          },
        } as never),
      },
    );

    const firstTurn = runtime.executeTurn("first prompt");
    await firstModelStarted.promise;

    const secondTurn = runtime.executeTurn("second prompt", undefined, {
      abortSignal: abortController.signal,
    });
    let secondRejected = false;
    let secondError: unknown;
    const observedSecondTurn = secondTurn.catch((error) => {
      secondRejected = true;
      secondError = error;
      return error;
    });

    try {
      abortController.abort(new Error("queued prompt cancelled"));
      await waitForMacrotask();

      expect(secondRejected).toBe(true);
      expect(modelCallCount).toBe(1);
    } finally {
      firstModelCanFinish.resolve();
      await firstTurn.catch(() => undefined);
      await observedSecondTurn;
    }

    expect(secondError).toMatchObject({ type: CoreErrorType.TurnCancelled });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
