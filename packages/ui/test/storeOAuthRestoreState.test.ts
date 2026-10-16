import type { IBroadcastService } from "@zcode/services";
import { beforeEach, describe, expect, it } from "vitest";
import { createZCodeStore } from "@/store/index.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

describe("createZCodeStore global state", () => {
  beforeEach(() => {
    localStorageState.clear();
  });

  it("默认不处于 OAuth 启动恢复中", () => {
    const store = createZCodeStore(mockBroadcastService);

    expect(store.getState().isRestoringOAuthSession).toBe(false);
  });

  it("支持在首次渲染前把 OAuth 恢复态初始化为 pending", () => {
    const store = createZCodeStore(mockBroadcastService, {
      initialIsRestoringOAuthSession: true,
    });

    expect(store.getState().isRestoringOAuthSession).toBe(true);
  });

  it("支持请求统一登录入口直接进入指定 provider 的登录流程", () => {
    const store = createZCodeStore(mockBroadcastService);

    const requestId = store.getState().requestLoginEntry("zai");

    const request = store.getState().loginEntryRequest;
    expect(request?.providerId).toBe("zai");
    expect(requestId).toBe(request?.id);
    expect(store.getState().loginEntryAttempt).toEqual({
      id: requestId,
      providerId: "zai",
      purpose: undefined,
      status: "requested",
    });

    store.getState().markLoginEntryAttemptStatus(requestId, "waiting");
    expect(store.getState().loginEntryAttempt?.status).toBe("waiting");

    store.getState().clearLoginEntryRequest(request?.id);

    expect(store.getState().loginEntryRequest).toBe(null);
  });

  it("登录尝试取消后不会被旧请求或后续新请求误更新", () => {
    const store = createZCodeStore(mockBroadcastService);
    const cancelledId = store.getState().requestLoginEntry("zai");
    store.getState().markLoginEntryAttemptStatus(cancelledId, "cancelled");
    const currentId = store.getState().requestLoginEntry("bigmodel");

    store.getState().markLoginEntryAttemptStatus(cancelledId, "succeeded");

    expect(store.getState().loginEntryAttempt).toMatchObject({
      id: currentId,
      providerId: "bigmodel",
      status: "requested",
    });
  });

  it("只在用户从未登录进入登录态时推进鉴权会话序号", () => {
    const store = createZCodeStore(mockBroadcastService);
    const user = { id: "user-1", username: "tester", displayName: "Tester" };

    store.getState().setUser(user);
    expect(store.getState().authSessionSeq).toBe(1);

    // 已登录时刷新用户信息或连接额外 provider，不属于重新登录。
    store.getState().setUser({ ...user, displayName: "Tester Updated" });
    expect(store.getState().authSessionSeq).toBe(1);

    store.getState().setUser(null);
    store.getState().setUser(user);
    expect(store.getState().authSessionSeq).toBe(2);
  });

  it("同一自动完成历史保留首次鉴权会话且拒绝旧会话回写", () => {
    const store = createZCodeStore(mockBroadcastService);
    const user = { id: "user-1", username: "tester", displayName: "Tester" };
    const firstCompletedAt = Date.now() - 10_000;
    const secondCompletedAt = Date.now() - 1_000;

    store.getState().setUser(user);
    store.getState().setCodingPlanQuotaResetUiEntry(
      "composer:test",
      "WEEK",
      {
        status: "completed",
        opportunityCount: 0,
        opportunityExpiresAt: null,
        startedAt: null,
        completedAt: firstCompletedAt,
        observedAt: firstCompletedAt + 100,
        quotaOverridePending: false,
        nextResetAt: null,
        idempotencyKey: null,
        error: null,
      },
      1,
    );

    store.getState().setUser(null);
    store.getState().setUser(user);
    store.getState().setCodingPlanQuotaResetUiEntry(
      "composer:test",
      "WEEK",
      {
        status: "completed",
        opportunityCount: 0,
        opportunityExpiresAt: null,
        startedAt: null,
        completedAt: firstCompletedAt,
        observedAt: null,
        quotaOverridePending: false,
        nextResetAt: null,
        idempotencyKey: null,
        error: null,
      },
      2,
    );

    expect(
      store.getState().codingPlanQuotaResetAutomaticObservationsBySource[
        "composer:test"
      ]?.week,
    ).toEqual({ completedAt: firstCompletedAt, authSessionSeq: 1 });

    // 上一鉴权会话尚未结束的异步请求不能覆盖当前会话状态。
    store.getState().setCodingPlanQuotaResetUiEntry(
      "composer:test",
      "WEEK",
      {
        status: "completed",
        opportunityCount: 0,
        opportunityExpiresAt: null,
        startedAt: null,
        completedAt: secondCompletedAt,
        observedAt: secondCompletedAt + 100,
        quotaOverridePending: true,
        nextResetAt: null,
        idempotencyKey: null,
        error: null,
      },
      1,
    );
    expect(
      store.getState().codingPlanQuotaResetUiBySource["composer:test"]?.week
        ?.completedAt,
    ).toBe(firstCompletedAt);
  });

  it("记录最近一次 OAuth 成功的平台", () => {
    const store = createZCodeStore(mockBroadcastService);

    store.getState().markOAuthSuccess("zai");

    expect(store.getState().oauthSuccessSeq).toBe(1);
    expect(store.getState().lastOAuthSuccessProvider).toBe("zai");
  });

  it("性能模式默认关闭，并持久化用户选择", () => {
    const store = createZCodeStore(mockBroadcastService);

    expect(store.getState().performanceMode).toBe(false);

    store.getState().setPerformanceMode(true);

    expect(store.getState().performanceMode).toBe(true);
    expect(localStorageState.get("zcode-performance-mode")).toBe("true");
    expect(
      createZCodeStore(mockBroadcastService).getState().performanceMode,
    ).toBe(true);
  });
});
