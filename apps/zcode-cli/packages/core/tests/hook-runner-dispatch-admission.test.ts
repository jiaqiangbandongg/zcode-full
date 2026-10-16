import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  type HookExecutionDescriptor,
  type HookRunLifecyclePayload,
  type SessionEvent,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { HookInput } from "../src/hooks/types.js";

/**
 * dispatch 前重验 admission（CR-01 回归）。
 *
 * Bug 背景：runner.run() 曾在执行循环前对全部 matchingHooks 预计算
 * resolveHookRunAdmission 并缓存结果。一次事件匹配多个顺序执行的 Hook 时，
 * 前序 Hook 运行期间发生的 revoke / Trust store reload / policy 收紧
 * 对后续尚未开始的 Hook 不生效——被撤销的本地命令仍会按旧的 allowed:true 启动，
 * 违反 spec「revoke 对未开始的 Hook execution 立即 blocked」的承诺。
 *
 * 预扫描保留（skipLifecycle 剔除与 hookCount 计算，见 H1 注释），
 * 但授权决定必须在每个 Hook 实际 dispatch（HookRunStarted / 后台任务创建）前
 * 重新解析。以下用可翻转的 admission 模拟运行中 revoke 与 policy 收紧。
 */

const visibleDescriptor: HookExecutionDescriptor = {
  clientVisible: true,
  commandDisplay: "hook-command",
  executionMode: "foreground",
  executionType: "process",
  sourceKind: "user",
  sourcePath: "/Users/example/.zcode/cli/config.json",
  timeoutMs: 60_000,
};

function promptInput(): HookInput {
  return {
    cwd: "/workspace",
    hookEventName: HookEventName.UserPromptSubmit,
    mode: "build",
    prompt: "hello",
    sessionId: createSessionId("hook-dispatch-admission"),
    timestamp: new Date().toISOString(),
    traceId: createTraceId(),
    turnId: createTurnId("turn-1"),
  } as HookInput;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Hook runner dispatch-time admission（CR-01）", () => {
  it("前序 Hook 运行中 revoke 后续 Hook：后续 Hook 必须 Blocked 且 callback 不执行", async () => {
    const events: SessionEvent[] = [];
    const hook1Started = deferred<void>();
    const releaseHook1 = deferred<void>();
    let secondHookAllowed = true;
    let secondHookCallbackRan = false;

    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: async () => {
            hook1Started.resolve();
            await releaseHook1.promise;
            return undefined;
          },
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
        {
          admission: () => ({
            allowed: secondHookAllowed,
            reasonCode: secondHookAllowed ? undefined : "workspace_hooks_trust_revoked",
          }),
          callback: () => {
            secondHookCallbackRan = true;
            return undefined;
          },
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    const runPromise = runner.run(promptInput());
    await hook1Started.promise;
    // 前序 Hook 尚在运行：此时撤销第二个 Hook 的 Trust。
    secondHookAllowed = false;
    releaseHook1.resolve();
    await runPromise;

    expect(secondHookCallbackRan).toBe(false);

    const secondHookEvents = events.filter(
      (event) => (event.payload as HookRunLifecyclePayload).hookIndex === 1,
    );
    expect(secondHookEvents.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    expect((secondHookEvents[0]!.payload as HookRunLifecyclePayload).errorCode).toBe(
      "workspace_hooks_trust_revoked",
    );
    expect((secondHookEvents[0]!.payload as HookRunLifecyclePayload).blockReason).toBe(
      "workspace_hooks_trust_revoked",
    );
  });

  it("前序 Hook 运行中 policy 收紧为 deny：未启动的异步 Hook 不得创建任务", async () => {
    const events: SessionEvent[] = [];
    const hook1Started = deferred<void>();
    const releaseHook1 = deferred<void>();
    let policyDeny = false;
    let asyncHookCallbackRan = false;

    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: async () => {
            hook1Started.resolve();
            await releaseHook1.promise;
            return undefined;
          },
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
        {
          admission: () => ({
            allowed: !policyDeny,
            reasonCode: policyDeny ? "workspace_hooks_blocked_by_policy" : undefined,
          }),
          async: true,
          callback: () => {
            asyncHookCallbackRan = true;
            return undefined;
          },
          descriptor: { ...visibleDescriptor, executionMode: "background" },
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    const runPromise = runner.run(promptInput());
    await hook1Started.promise;
    policyDeny = true;
    releaseHook1.resolve();
    await runPromise;
    // async 生命周期不在 run() 的 await 范围内，给潜在的（不该存在的）后台任务
    // 一个微任务窗口，再断言它从未被创建。
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(asyncHookCallbackRan).toBe(false);
    const asyncHookEvents = events.filter(
      (event) => (event.payload as HookRunLifecyclePayload).hookIndex === 1,
    );
    expect(asyncHookEvents.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    expect((asyncHookEvents[0]!.payload as HookRunLifecyclePayload).errorCode).toBe(
      "workspace_hooks_blocked_by_policy",
    );
    expect((asyncHookEvents[0]!.payload as HookRunLifecyclePayload).blockReason).toBe(
      "workspace_hooks_blocked_by_policy",
    );
  });

  it("预扫描仍负责 skipLifecycle 剔除与 hookCount（H1 行为不回归）", async () => {
    const events: SessionEvent[] = [];
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          // 配置禁用的 workspace hook：skipLifecycle，不参与计数也不发事件。
          admission: () => ({ allowed: false, skipLifecycle: true }),
          callback: () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
        {
          callback: () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    await runner.run(promptInput());

    const lifecycleEvents = events.filter(
      (event) => event.type === SessionEventType.HookRunStarted,
    );
    expect(lifecycleEvents).toHaveLength(1);
    expect((lifecycleEvents[0]!.payload as HookRunLifecyclePayload).hookCount).toBe(1);
  });
});
