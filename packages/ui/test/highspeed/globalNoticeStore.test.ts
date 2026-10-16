import { describe, expect, it, vi } from "vitest";
import {
  createGlobalNoticeStore,
  type GlobalNoticeEnvelope,
  type GlobalNoticeStorage,
} from "@/global-notice/globalNoticeStore.js";

function memoryStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function shareNotice(now: number): GlobalNoticeEnvelope {
  return {
    noticeId: "notice-1",
    dedupeKey: "highspeed-share:latest",
    type: "highspeed-share",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + 60_000,
    payload: { cardId: "hsc-1", tokenUsage: 100, durationMs: 1_000, savedDurationMs: 500 },
    actions: [],
    dismissPolicy: { kind: "cooldown", cooldownMs: 24 * 60 * 60_000 },
    persistencePolicy: "latest-only",
    source: "highspeed",
    revision: 1,
  };
}

function quotaExceeded(): Error {
  const error = new Error("The quota has been exceeded.");
  error.name = "QuotaExceededError";
  return error;
}

describe("global notice store", () => {
  it("drops a persisted legacy Highspeed mock notice during hydration", () => {
    const storage = memoryStorage();
    storage.setItem(
      "zcode:global-notice:v1",
      JSON.stringify({
        version: 1,
        latest: {
          noticeId: "highspeed-share:share_hsc_mock_1:1000",
          dedupeKey: "highspeed-share:latest",
          type: "highspeed-share",
          schemaVersion: 1,
          scope: "user",
          priority: "normal",
          interruptPolicy: "passive",
          createdAt: 1000,
          expiresAt: 2000,
          payload: {
            cardId: "hsc_mock_1",
            shareUrl: "https://mock.z.ai/highspeed/share/hsc_mock_1",
          },
          actions: [],
          dismissPolicy: { kind: "cooldown", cooldownMs: 24 * 60 * 60_000 },
          persistencePolicy: "latest-only",
          source: "highspeed",
          revision: 1000,
        },
        dismissedUntilByKey: {},
        requiresPublishAfterDismissalByKey: { "highspeed-share:latest": false },
      }),
    );

    const store = createGlobalNoticeStore({ storage, now: () => 1500 });

    expect(store.getVisible()).toBeNull();
    expect(store.getSnapshot().latest).toBeNull();
    expect(JSON.parse(storage.getItem("zcode:global-notice:v1") ?? "null").latest).toBeNull();
  });

  it("persists latest-only Highspeed notice and enforces a user-level 24h dismissal", () => {
    let now = 1000;
    const storage = memoryStorage();
    const store = createGlobalNoticeStore({ storage, now: () => now });

    store.publish({
      noticeId: "notice-1",
      dedupeKey: "highspeed-share:latest",
      type: "highspeed-share",
      schemaVersion: 1,
      scope: "user",
      priority: "normal",
      interruptPolicy: "passive",
      createdAt: now,
      expiresAt: now + 60_000,
      payload: { cardId: "hsc-1", shareUrl: "https://example.test/s/1" },
      actions: [],
      dismissPolicy: { kind: "cooldown", cooldownMs: 24 * 60 * 60_000 },
      persistencePolicy: "latest-only",
      source: "highspeed",
      revision: 1,
    });
    expect(store.getVisible()?.noticeId).toBe("notice-1");

    store.dismiss("notice-1");
    expect(store.getVisible()).toBeNull();

    store.publish({
      ...store.getSnapshot().latest!,
      noticeId: "notice-2",
      createdAt: now + 1,
      revision: 2,
    });
    expect(store.getVisible()).toBeNull();

    now += 24 * 60 * 60_000 + 1;
    expect(store.getVisible()).toBeNull();
    store.publish({
      ...store.getSnapshot().latest!,
      noticeId: "notice-3",
      createdAt: now,
      expiresAt: now + 60_000,
      revision: 3,
    });
    expect(store.getVisible()?.noticeId).toBe("notice-3");
  });

  it("keeps publish/dismiss working and notifies subscribers when storage writes fail", () => {
    // CR-03 回归：setItem 抛 QuotaExceeded 曾让 publish 抛错、订阅者收不到内存态更新；
    // SessionPane 已先 claim 自动分享再 publish，异常会留下不可重试的 claim，分享卡永远不出现。
    const backing = memoryStorage();
    let failWrites = false;
    const flaky: GlobalNoticeStorage = {
      ...backing,
      setItem: (key, value) => {
        if (failWrites) throw quotaExceeded();
        backing.setItem(key, value);
      },
    };
    const failures: unknown[] = [];
    const store = createGlobalNoticeStore({
      storage: flaky,
      now: () => 1000,
      onPersistError: (error) => failures.push(error),
    });
    const listener = vi.fn();
    store.subscribe(listener);

    failWrites = true;
    expect(() => store.publish(shareNotice(1000))).not.toThrow();
    expect(store.getVisible()?.noticeId).toBe("notice-1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).name).toBe("QuotaExceededError");

    expect(() => store.dismiss("notice-1")).not.toThrow();
    expect(store.getVisible()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    // 存储恢复后下一次写入照常落盘，内存态与持久态重新对齐。
    failWrites = false;
    store.publish({ ...shareNotice(2000), noticeId: "notice-2", revision: 2 });
    expect(JSON.parse(backing.getItem("zcode:global-notice:v1") ?? "null").latest.noticeId).toBe(
      "notice-2",
    );
  });

  it("drops the legacy mock notice even when the cleanup write fails", () => {
    const backing = memoryStorage();
    backing.setItem(
      "zcode:global-notice:v1",
      JSON.stringify({
        version: 1,
        latest: { ...shareNotice(1000), payload: { cardId: "hsc_mock_1" } },
        dismissedUntilByKey: { "highspeed-share:latest": 5000 },
        requiresPublishAfterDismissalByKey: {},
      }),
    );
    const readOnly: GlobalNoticeStorage = {
      ...backing,
      setItem: () => {
        throw quotaExceeded();
      },
    };
    const failures: unknown[] = [];
    const store = createGlobalNoticeStore({
      storage: readOnly,
      now: () => 1500,
      onPersistError: (error) => failures.push(error),
    });

    expect(store.getSnapshot().latest).toBeNull();
    // 清理写失败不能把整份状态打回空：已有的 24h 静默必须保留。
    expect(store.getSnapshot().dismissedUntilByKey["highspeed-share:latest"]).toBe(5000);
    expect(failures).toHaveLength(1);
  });
});
