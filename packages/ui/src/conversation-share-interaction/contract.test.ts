import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("改选发生在 debounce 内时不发送旧请求", async () => {
  const request = vi.fn(async () => "old");
  const cancel = scheduleConversationSharePreflightRequest({
    request,
    onResolved: vi.fn(),
    onRejected: vi.fn(),
    onError: vi.fn(),
  });
  cancel();
  await vi.runAllTimersAsync();
  expect(request).not.toHaveBeenCalled();
});

// 改选、取消、关闭和切任务共用 effect cleanup；只计一次清理契约，不按操作名称复制测试。
it("effect 清理后旧成功/失败不得覆盖新代际", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const old = deferred();
    const current = deferred();
    const write = vi.fn();
    const fail = vi.fn();
    const unexpected = vi.fn();
    const cancel = scheduleConversationSharePreflightRequest({
      request: () => old.promise,
      onResolved: write,
      onRejected: fail,
      onError: unexpected,
    });
    await vi.advanceTimersByTimeAsync(150);
    cancel();
    scheduleConversationSharePreflightRequest({
      request: () => current.promise,
      onResolved: write,
      onRejected: fail,
      onError: unexpected,
    });
    await vi.advanceTimersByTimeAsync(150);
    current.resolve("current");
    await vi.runAllTimersAsync();
    if (outcome === "resolve") old.resolve("stale");
    else old.reject(new Error("stale failure"));
    await vi.runAllTimersAsync();
    expect(write.mock.calls).toEqual([["current"]]);
    expect(fail).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
  }
});

it("当前传输失败进入失败分支，处理器异常单独报告", async () => {
  const fail = vi.fn();
  const unexpected = vi.fn();
  scheduleConversationSharePreflightRequest({
    request: async () => {
      throw new Error("transport");
    },
    onResolved: vi.fn(),
    onRejected: fail,
    onError: unexpected,
  });
  await vi.runAllTimersAsync();
  expect(fail).toHaveBeenCalledWith(new Error("transport"));
  expect(unexpected).not.toHaveBeenCalled();
  scheduleConversationSharePreflightRequest({
    request: async () => "ok",
    onResolved: () => {
      throw new Error("render");
    },
    onRejected: fail,
    onError: unexpected,
  });
  await vi.runAllTimersAsync();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(unexpected).toHaveBeenCalledWith(new Error("render"));
});
