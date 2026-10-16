// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IUsageStatsService } from "@zcode/services";
import type { CodingPlanResetScopeRequest } from "@zcode/shared";
import {
  requestCodingPlanResetOpportunityWhenDue,
  subscribeCodingPlanQuotaResetPolling,
} from "@/lib/codingPlanQuotaResetCoordinator.js";

const scope: CodingPlanResetScopeRequest = {
  preferredProviderId: "builtin:personal",
};

function createService(
  requestCodingPlanResetOpportunity = vi.fn(async () => ({
    granted: false,
    nextTryAt: null,
  })),
): IUsageStatsService {
  return { requestCodingPlanResetOpportunity } as unknown as IUsageStatsService;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("codingPlanQuotaResetCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("同一鉴权会话和 scope 的多个入口只启动一个轮询", async () => {
    const service = createService();
    const firstRefresh = vi.fn(async () => undefined);
    const secondRefresh = vi.fn(async () => undefined);

    const unsubscribeFirst = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 3,
      scope,
      refresh: firstRefresh,
    });
    const unsubscribeSecond = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 3,
      scope,
      refresh: secondRefresh,
    });
    await flushMicrotasks();

    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(secondRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(firstRefresh).toHaveBeenCalledTimes(2);
    expect(secondRefresh).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(secondRefresh).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(secondRefresh).toHaveBeenCalledTimes(3);
  });

  it("轮询进行中重挂载的入口也会立即完成自己的状态投影", async () => {
    let resolveFirst: (() => void) | null = null;
    const firstRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondRefresh = vi.fn(async () => undefined);
    const service = createService();

    const unsubscribeFirst = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 30,
      scope,
      refresh: firstRefresh,
    });
    await flushMicrotasks();
    expect(firstRefresh).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    const unsubscribeSecond = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 30,
      scope,
      refresh: secondRefresh,
    });
    await flushMicrotasks();
    expect(secondRefresh).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await flushMicrotasks();
    unsubscribeSecond();
  });

  it("多个入口和 HoverCard 重挂载共享同一次 opportunity 调度", async () => {
    const request = vi.fn(async () => ({
      granted: false,
      nextTryAt: Date.now() + 10 * 60_000,
    }));
    const service = createService(request);
    const refresh = () =>
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 31,
        scope,
      });

    const unsubscribeFirst = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 31,
      scope,
      refresh,
    });
    const unsubscribeSecond = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 31,
      scope,
      refresh,
    });
    await flushMicrotasks();
    expect(request).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
    const unsubscribeRemount = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 31,
      scope,
      refresh,
    });
    await flushMicrotasks();
    expect(request).toHaveBeenCalledTimes(1);
    unsubscribeRemount();
  });

  it("页面 hidden 时暂停，恢复 visible 后立即由唯一 owner 校正", async () => {
    const service = createService();
    const refresh = vi.fn(async () => undefined);
    const unsubscribe = subscribeCodingPlanQuotaResetPolling({
      service,
      authSessionSeq: 4,
      scope,
      refresh,
    });
    await flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("granted=false 时按服务端 nextTryAt 抑制重复 opportunity", async () => {
    const nextTryAt = Date.now() + 10 * 60_000;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ granted: false, nextTryAt })
      .mockResolvedValueOnce({
        granted: false,
        nextTryAt: nextTryAt + 10 * 60_000,
      });
    const service = createService(request);

    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 5,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt });
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 5,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 5,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 5,
        scope,
      }),
    ).resolves.toEqual({
      granted: false,
      nextTryAt: nextTryAt + 10 * 60_000,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      request.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("服务端 nextTryAt 已经过期时至少等待五分钟再判断 opportunity", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ granted: false, nextTryAt: Date.now() - 1_000 })
      .mockResolvedValueOnce({ granted: false, nextTryAt: null });
    const service = createService(request);

    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 51,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: expect.any(Number) });

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 51,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 51,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: null });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("网络或依赖错误固定五分钟后重试并复用幂等 key", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("coding_plan_reset_api_error:2007"))
      .mockResolvedValueOnce({
        granted: false,
        nextTryAt: Date.now() + 600_000,
      });
    const service = createService(request);

    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 6,
        scope,
      }),
    ).rejects.toThrow("2007");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 6,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 6,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: expect.any(Number) });
    expect(request.mock.calls[0]?.[0].idempotencyKey).toBe(
      request.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("鉴权等稳定错误固定冷却十分钟并使用新幂等 key", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("coding_plan_reset_maas_jwt_required"))
      .mockResolvedValueOnce({ granted: false, nextTryAt: null });
    const service = createService(request);

    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 61,
        scope,
      }),
    ).rejects.toThrow("maas_jwt_required");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 61,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 61,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: null });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      request.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("429 固定冷却十分钟", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("coding_plan_reset_opportunity_throttled"))
      .mockResolvedValueOnce({ granted: false, nextTryAt: null });
    const service = createService(request);

    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 7,
        scope,
      }),
    ).rejects.toThrow("throttled");
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 7,
        scope,
      }),
    ).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await expect(
      requestCodingPlanResetOpportunityWhenDue({
        service,
        authSessionSeq: 7,
        scope,
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: null });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      request.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("authSessionSeq 变化后不复用旧会话的冷却", async () => {
    const request = vi.fn(async () => ({
      granted: false,
      nextTryAt: Date.now() + 10 * 60_000,
    }));
    const service = createService(request);

    await requestCodingPlanResetOpportunityWhenDue({
      service,
      authSessionSeq: 8,
      scope,
    });
    await requestCodingPlanResetOpportunityWhenDue({
      service,
      authSessionSeq: 9,
      scope,
    });

    expect(request).toHaveBeenCalledTimes(2);
  });
});
