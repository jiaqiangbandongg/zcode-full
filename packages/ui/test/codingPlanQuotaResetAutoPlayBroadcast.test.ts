// @vitest-environment jsdom
// 跨窗口自动完成提示抑制：一个窗口播放后，其他窗口不得再播放（Tooltip/撒花）。
// 覆盖 store 广播/接收、hook 创建期抑制、history/read 提前上报与撒花 arm 清理。
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage, IBroadcastService, IUsageStatsService } from "@zcode/services";
import type { CodingPlanResetStatusSnapshot, ZCodeAccountAccess } from "@zcode/shared";
import { StoreContext } from "@/store/StoreProvider.js";

const mocks = vi.hoisted(() => ({
  services: null as { usageStatsService: IUsageStatsService } | null,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => mocks.services,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
}));

import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { coordinateCodingPlanQuotaResetAutoPlay } from "@/chat-input-toolbar/codingPlanQuotaResetAutoPlay.js";
import { pruneCodingPlanQuotaResetConfettiArms } from "@/lib/codingPlanQuotaResetUi.js";
import { CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL } from "@/store/codingPlanQuotaResetState.js";
import { createZCodeStore } from "@/store/index.js";
import type { ZCodeStore } from "@/store/index.js";

const TEST_ACCOUNT_ACCESS: ZCodeAccountAccess = {
  type: "zhipu-account",
  family: "bigmodel",
  planKind: "individual-coding-plan",
};

type BroadcastListener = (message: BroadcastMessage) => void;

function createBroadcastHarness({
  claimStatus = "acquired",
}: {
  claimStatus?: "acquired" | "busy" | "committed";
} = {}) {
  const listeners = new Set<BroadcastListener>();
  const send = vi.fn(async () => undefined);
  const acquireClaim = vi.fn(async (key: string) =>
    claimStatus === "acquired"
      ? { status: "acquired" as const, lease: { key, token: "claim-token" } }
      : claimStatus === "busy"
        ? { status: "busy" as const, retryAfterMs: 100 }
        : { status: "committed" as const },
  );
  const commitClaim = vi.fn(async () => undefined);
  const releaseClaim = vi.fn(async () => undefined);
  const tryClaim = vi.fn(async () => false);
  const service = {
    send,
    acquireClaim,
    commitClaim,
    releaseClaim,
    tryClaim,
    onMessage: (listener: BroadcastListener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as IBroadcastService;
  return {
    service,
    send,
    acquireClaim,
    commitClaim,
    releaseClaim,
    tryClaim,
    emit: (message: BroadcastMessage) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
}

function automaticCompletedEntry(completedAt: number, observedAt: number | null) {
  return {
    status: "completed" as const,
    opportunityCount: 0,
    opportunityExpiresAt: null,
    startedAt: null,
    completedAt,
    observedAt,
    quotaOverridePending: true,
    nextResetAt: completedAt + 5 * 60 * 60 * 1_000,
    idempotencyKey: null,
    error: null,
  };
}

function manualCompletedEntry(completedAt: number, startedAt: number) {
  return { ...automaticCompletedEntry(completedAt, null), startedAt };
}

function status(
  overrides: Partial<CodingPlanResetStatusSnapshot> = {},
): CodingPlanResetStatusSnapshot {
  return {
    availableFiveHourResets: [],
    availableWeekResets: [],
    latestFiveHourResetHistory: null,
    latestWeekResetHistory: null,
    hasUnreadHistory: false,
    ...overrides,
  };
}

function createUsageStatsService(overrides: Partial<IUsageStatsService> = {}): IUsageStatsService {
  return {
    getAppUsageSnapshot: vi.fn(),
    getCodingPlanUsageSnapshot: vi.fn(),
    getCodingPlanResetStatus: vi.fn(async () => status()),
    requestCodingPlanResetOpportunity: vi.fn(async () => ({
      granted: false,
      nextTryAt: null,
    })),
    useCodingPlanReset: vi.fn(async () => ({ used: true as const })),
    markCodingPlanResetHistoryRead: vi.fn(async () => undefined),
    getSnapshot: vi.fn(),
    getEntitlementSnapshot: vi.fn(),
    ...overrides,
  };
}

function wrapperFor(store: ZCodeStore) {
  return ({ children }: { children: ReactNode }) =>
    createElement(StoreContext.Provider, { value: store }, children);
}

describe("coding plan quota reset autoplay broadcast (store)", () => {
  it("status 写入只记录 observation，非 Composer 入口不占用播放资格", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);

    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry(
          "src",
          "FIVE_HOUR",
          automaticCompletedEntry(1_000, 2_000),
          0,
        );
    });

    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src).toBeUndefined();
    expect(harness.acquireClaim).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("Composer reservation winner 在 commit 前不写 played、不广播", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry(
          "src",
          "FIVE_HOUR",
          automaticCompletedEntry(1_000, 2_000),
          0,
        );
    });

    const attempt = await store
      .getState()
      .reserveCodingPlanQuotaResetAutoPlay("src", "FIVE_HOUR", 1_000);

    expect(attempt).toEqual({
      status: "reserved",
      reservation: expect.objectContaining({
        sourceKey: "src",
        resetType: "FIVE_HOUR",
        completedAt: 1_000,
      }),
    });
    expect(harness.acquireClaim).toHaveBeenCalledWith(
      "coding-plan-reset-autoplay:src:FIVE_HOUR:1000",
    );
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src).toBeUndefined();
    expect(harness.send).not.toHaveBeenCalled();

    if (attempt.status !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(store.getState().commitCodingPlanQuotaResetAutoPlay(attempt.reservation)).toBe(true);
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src?.fiveHour).toBe(1_000);
    expect(harness.commitClaim).toHaveBeenCalledWith(attempt.reservation.lease);
    expect(harness.send).toHaveBeenCalledWith({
      channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
      payload: { sourceKey: "src", resetType: "FIVE_HOUR", completedAt: 1_000 },
    });
    expect(store.getState().codingPlanQuotaResetUiBySource.src?.fiveHour?.observedAt).toBe(2_000);
  });

  it("Composer acquire busy 保留 observed_at，不把占用误当成 played", async () => {
    const harness = createBroadcastHarness({ claimStatus: "busy" });
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry("src", "WEEK", automaticCompletedEntry(3_000, 4_000), 0);
    });

    await expect(
      store.getState().reserveCodingPlanQuotaResetAutoPlay("src", "WEEK", 3_000),
    ).resolves.toEqual({ status: "retry", retryAfterMs: 100 });

    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src).toBeUndefined();
    expect(store.getState().codingPlanQuotaResetUiBySource.src?.week?.observedAt).toBe(4_000);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("reservation 释放时不写 played，后续窗口仍可继续争抢", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry("src", "WEEK", automaticCompletedEntry(3_000, 4_000), 0);
    });

    const attempt = await store
      .getState()
      .reserveCodingPlanQuotaResetAutoPlay("src", "WEEK", 3_000);
    if (attempt.status !== "reserved") {
      throw new Error("expected reservation");
    }
    await store.getState().releaseCodingPlanQuotaResetAutoPlay(attempt.reservation);

    expect(harness.releaseClaim).toHaveBeenCalledWith(attempt.reservation.lease);
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src).toBeUndefined();
    expect(store.getState().codingPlanQuotaResetUiBySource.src?.week?.observedAt).toBe(4_000);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("手动完成不会被 claim 成自动播放", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry("src", "FIVE_HOUR", manualCompletedEntry(1_000, 900), 0);
    });

    await expect(
      store.getState().reserveCodingPlanQuotaResetAutoPlay("src", "FIVE_HOUR", 1_000),
    ).resolves.toEqual({ status: "blocked" });
    expect(harness.acquireClaim).not.toHaveBeenCalled();
  });

  it("收到跨窗口广播后抑制本窗口正在等待 claim 的同 used_at 自动完成", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);

    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry(
          "src",
          "FIVE_HOUR",
          automaticCompletedEntry(1_000, Date.now()),
          0,
        );
      harness.emit({
        channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
        payload: {
          sourceKey: "src",
          resetType: "FIVE_HOUR",
          completedAt: 1_000,
        },
        sourceWindowId: 7,
      });
    });

    expect(store.getState().codingPlanQuotaResetUiBySource.src?.fiveHour?.observedAt).toBeNull();
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src?.fiveHour).toBe(1_000);
  });

  it("本地回声（无 sourceWindowId）不抑制 winner 的播放", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry(
          "src",
          "FIVE_HOUR",
          automaticCompletedEntry(1_000, Date.now()),
          0,
        );
    });
    const attempt = await store
      .getState()
      .reserveCodingPlanQuotaResetAutoPlay("src", "FIVE_HOUR", 1_000);
    if (attempt.status !== "reserved") {
      throw new Error("expected reservation");
    }
    store.getState().commitCodingPlanQuotaResetAutoPlay(attempt.reservation);

    act(() => {
      harness.emit({
        channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
        payload: {
          sourceKey: "src",
          resetType: "FIVE_HOUR",
          completedAt: 1_000,
        },
      });
    });

    expect(
      store.getState().codingPlanQuotaResetUiBySource.src?.fiveHour?.observedAt,
    ).not.toBeNull();
  });

  it("旧广播晚到不会把较新的 played 记录回退", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store.setState({
        codingPlanQuotaResetAutoPlayedBySource: {
          src: { fiveHour: 2_000, week: null },
        },
      });
      harness.emit({
        channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
        payload: {
          sourceKey: "src",
          resetType: "FIVE_HOUR",
          completedAt: 1_000,
        },
        sourceWindowId: 7,
      });
    });

    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src?.fiveHour).toBe(2_000);
  });

  it("used_at 不匹配的广播只合并 played 记录，不改写 entry", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    act(() => {
      store
        .getState()
        .setCodingPlanQuotaResetUiEntry(
          "src",
          "WEEK",
          automaticCompletedEntry(5_000, Date.now()),
          0,
        );
      harness.emit({
        channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
        payload: { sourceKey: "src", resetType: "WEEK", completedAt: 9_999 },
        sourceWindowId: 7,
      });
    });

    const entry = store.getState().codingPlanQuotaResetUiBySource.src?.week;
    expect(entry?.completedAt).toBe(5_000);
    expect(entry?.observedAt).not.toBeNull();
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource.src?.week).toBe(9_999);
  });

  it("非法 payload 的广播被忽略", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);

    expect(() => {
      act(() => {
        harness.emit({
          channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
          payload: { sourceKey: "src" },
          sourceWindowId: 7,
        });
        harness.emit({
          channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
          payload: { sourceKey: "src", resetType: "BAD", completedAt: 1 },
          sourceWindowId: 7,
        });
      });
    }).not.toThrow();
    expect(store.getState().codingPlanQuotaResetAutoPlayedBySource).toEqual({});
  });
});

describe("coordinateCodingPlanQuotaResetAutoPlay", () => {
  it("reservation 返回前组件已卸载时只 release，不 commit played", async () => {
    const reservation = {
      sourceKey: "src",
      resetType: "FIVE_HOUR" as const,
      completedAt: 1_000,
      lease: { key: "claim-key", token: "claim-token" },
    };
    let resolveAttempt!: (attempt: { status: "reserved"; reservation: typeof reservation }) => void;
    const reserve = vi.fn(
      () =>
        new Promise<{ status: "reserved"; reservation: typeof reservation }>((resolve) => {
          resolveAttempt = resolve;
        }),
    );
    let current = true;
    const commit = vi.fn(() => true);
    const release = vi.fn(async () => undefined);
    const onCommitted = vi.fn();

    const pending = coordinateCodingPlanQuotaResetAutoPlay({
      reserve,
      isCurrent: () => current,
      commit,
      release,
      onCommitted,
    });
    current = false;
    resolveAttempt({ status: "reserved", reservation });

    await expect(pending).resolves.toEqual({ status: "released" });
    expect(release).toHaveBeenCalledWith(reservation);
    expect(commit).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("仍是当前候选时在同一展示边界 commit 并升级本组件状态", async () => {
    const reservation = {
      sourceKey: "src",
      resetType: "WEEK" as const,
      completedAt: 2_000,
      lease: { key: "claim-key", token: "claim-token" },
    };
    const commit = vi.fn(() => true);
    const release = vi.fn(async () => undefined);
    const onCommitted = vi.fn();

    await expect(
      coordinateCodingPlanQuotaResetAutoPlay({
        reserve: async () => ({ status: "reserved", reservation }),
        isCurrent: () => true,
        commit,
        release,
        onCommitted,
      }),
    ).resolves.toEqual({ status: "committed" });

    expect(commit).toHaveBeenCalledWith(reservation);
    expect(onCommitted).toHaveBeenCalledWith(reservation);
    expect(release).not.toHaveBeenCalled();
  });

  it("展示边界再次校验失败时 release reservation", async () => {
    const reservation = {
      sourceKey: "src",
      resetType: "WEEK" as const,
      completedAt: 2_000,
      lease: { key: "claim-key", token: "claim-token" },
    };
    const release = vi.fn(async () => undefined);
    const onCommitted = vi.fn();

    await expect(
      coordinateCodingPlanQuotaResetAutoPlay({
        reserve: async () => ({ status: "reserved", reservation }),
        isCurrent: () => true,
        commit: () => false,
        release,
        onCommitted,
      }),
    ).resolves.toEqual({ status: "released" });

    expect(release).toHaveBeenCalledWith(reservation);
    expect(onCommitted).not.toHaveBeenCalled();
  });
});

describe("coding plan quota reset autoplay broadcast (hook)", () => {
  beforeEach(() => {
    mocks.toast.mockReset();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("played 记录已存在时，轮询进入完成态但不播放提示", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    const usedAt = 12_345;
    act(() => {
      store.setState({
        codingPlanQuotaResetAutoPlayedBySource: {
          src: { fiveHour: usedAt, week: null },
        },
      });
    });
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({
        hasUnreadHistory: true,
        latestFiveHourResetHistory: { usedAt },
      }),
    );
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
      }),
    };

    const hook = renderHook(
      () =>
        useCodingPlanQuotaResetUi({
          sourceKey: "src",
          preferredProviderId: "p",
          accountAccess: TEST_ACCOUNT_ACCESS,
        }),
      { wrapper: wrapperFor(store) },
    );

    await waitFor(() => expect(hook.result.current.done).toBe(true));
    expect(hook.result.current.entry?.completedAt).toBe(usedAt);
    expect(hook.result.current.entry?.observedAt).toBeNull();
    expect(hook.result.current.statusVisible).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("Hook 观察完成后不自动占用，Composer 显式 claim 才播放", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    const usedAt = 23_456;
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus: vi.fn(async () =>
          status({
            hasUnreadHistory: true,
            latestFiveHourResetHistory: { usedAt },
          }),
        ),
      }),
    };

    const hook = renderHook(
      () =>
        useCodingPlanQuotaResetUi({
          sourceKey: "src",
          preferredProviderId: "p",
          accountAccess: TEST_ACCOUNT_ACCESS,
        }),
      { wrapper: wrapperFor(store) },
    );

    await waitFor(() => expect(hook.result.current.done).toBe(true));
    expect(harness.acquireClaim).not.toHaveBeenCalled();

    let attempt: Awaited<ReturnType<typeof hook.result.current.reserveAutomaticCompletion>>;
    await act(async () => {
      attempt = await hook.result.current.reserveAutomaticCompletion("FIVE_HOUR", usedAt);
    });

    expect(attempt!).toEqual(expect.objectContaining({ status: "reserved" }));
    expect(harness.acquireClaim).toHaveBeenCalledTimes(1);
    if (attempt!.status !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(hook.result.current.commitAutomaticCompletion(attempt!.reservation)).toBe(true);
    expect(
      store.getState().codingPlanQuotaResetUiBySource.src?.fiveHour?.observedAt,
    ).not.toBeNull();
  });

  it("Hook acquire busy 时保留自动完成候选", async () => {
    const harness = createBroadcastHarness({ claimStatus: "busy" });
    const store = createZCodeStore(harness.service);
    const usedAt = 34_567;
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus: vi.fn(async () =>
          status({
            hasUnreadHistory: true,
            latestWeekResetHistory: { usedAt },
          }),
        ),
      }),
    };

    const hook = renderHook(
      () =>
        useCodingPlanQuotaResetUi({
          sourceKey: "src",
          preferredProviderId: "p",
          accountAccess: TEST_ACCOUNT_ACCESS,
        }),
      { wrapper: wrapperFor(store) },
    );

    await waitFor(() => expect(hook.result.current.week.done).toBe(true));

    let attempt: Awaited<ReturnType<typeof hook.result.current.reserveAutomaticCompletion>>;
    await act(async () => {
      attempt = await hook.result.current.reserveAutomaticCompletion("WEEK", usedAt);
    });

    expect(attempt!).toEqual({ status: "retry", retryAfterMs: 100 });
    expect(store.getState().codingPlanQuotaResetUiBySource.src?.week?.observedAt).not.toBeNull();
  });

  it("观察到未读完成后立即上报 history/read，不等待 entitlement 刷新", async () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    const usedAt = 45_678;
    const markCodingPlanResetHistoryRead = vi.fn(async () => undefined);
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus: vi.fn(async () =>
          status({
            hasUnreadHistory: true,
            latestFiveHourResetHistory: { usedAt },
          }),
        ),
        markCodingPlanResetHistoryRead,
      }),
    };

    renderHook(
      () =>
        useCodingPlanQuotaResetUi({
          sourceKey: "src",
          preferredProviderId: "p",
          accountAccess: TEST_ACCOUNT_ACCESS,
          // 永不 resolve：旧实现 await 刷新后才上报已读，此测试会超时失败。
          onEntitlementRefresh: () => new Promise<void>(() => {}),
        }),
      { wrapper: wrapperFor(store) },
    );

    await waitFor(() => expect(markCodingPlanResetHistoryRead).toHaveBeenCalledTimes(1));
  });
});

describe("pruneCodingPlanQuotaResetConfettiArms", () => {
  it("清除已被抑制或被新 used_at 取代的补播撒花 arm", () => {
    expect(
      pruneCodingPlanQuotaResetConfettiArms(
        { FIVE_HOUR: 100, WEEK: 200 },
        { FIVE_HOUR: null, WEEK: null },
      ),
    ).toEqual({ FIVE_HOUR: null, WEEK: null });

    expect(
      pruneCodingPlanQuotaResetConfettiArms(
        { FIVE_HOUR: 100, WEEK: 200 },
        { FIVE_HOUR: 300, WEEK: 200 },
      ),
    ).toEqual({ FIVE_HOUR: null, WEEK: 200 });

    const unchanged = { FIVE_HOUR: 100 as number | null, WEEK: null };
    expect(
      pruneCodingPlanQuotaResetConfettiArms(unchanged, {
        FIVE_HOUR: 100,
        WEEK: null,
      }),
    ).toBe(unchanged);
  });
});
