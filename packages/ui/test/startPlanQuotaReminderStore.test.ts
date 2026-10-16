// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStartPlanQuotaReminderStore } from "@/v4/startPlanQuotaReminderStore.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("Start Plan 实际展示记录", () => {
  it("只在展示时登记；当前实例保留，其他任务/重启不重复，关闭后当前实例也隐藏", () => {
    const store = createStartPlanQuotaReminderStore({
      storage: () => localStorage,
    });
    const owner = {};
    expect(store.isHidden("bucket-cycle", owner, 1000)).toBe(false);
    store.markShown("bucket-cycle", 3000, owner, 1000);
    expect(store.isHidden("bucket-cycle", owner, 1000)).toBe(false);
    expect(store.isHidden("bucket-cycle", {}, 1000)).toBe(true);
    store.markShown("bucket-cycle", 3000, owner, 1000);
    expect(store.isHidden("bucket-cycle", owner, 1000)).toBe(false);
    const restarted = createStartPlanQuotaReminderStore({
      storage: () => localStorage,
    });
    expect(restarted.isHidden("bucket-cycle", {}, 1000)).toBe(true);
    expect(restarted.isHidden("new-cycle", {}, 1000)).toBe(false);
    store.dismiss("bucket-cycle");
    expect(store.isHidden("bucket-cycle", owner, 1000)).toBe(true);
  });
  it("另一实例不能接管已展示桶；清理到期记录但不删除其他业务数据", () => {
    const store = createStartPlanQuotaReminderStore({
      storage: () => localStorage,
    });
    const first = {};
    store.markShown("a", 2000, first, 1000);
    store.markShown("a", 2000, {}, 1000);
    expect(store.isHidden("a", first, 1000)).toBe(false);
    localStorage.setItem("unrelated", "keep");
    store.markShown("b", 3000, {}, 2001);
    expect(localStorage.length).toBe(2);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
  it("存储禁用时仍在内存去重，不阻断 UI", () => {
    const store = createStartPlanQuotaReminderStore({
      storage: () => {
        throw new Error("denied");
      },
    });
    expect(() => store.markShown("a", 2000, {}, 1000)).not.toThrow();
    expect(store.isHidden("a", {}, 1000)).toBe(true);
  });
});

// 回归：服务端仍有效的周期不能被设备时钟提前判为过期，缓存快照也不按墙钟外推。
it.each([900, 2100, 2200])("设备时间 %i 不影响同周期展示、关闭和重启去重", (deviceNow) => {
  vi.spyOn(Date, "now").mockReturnValue(deviceNow);
  const store = createStartPlanQuotaReminderStore({ storage: () => localStorage });
  const owner = {};
  const serverNow = 1900;
  store.markShown("clock-cycle", 2000, owner, serverNow);
  expect(localStorage.length).toBe(1);
  expect(store.isHidden("clock-cycle", owner, serverNow)).toBe(false);
  vi.mocked(Date.now).mockReturnValue(10000);
  store.dismiss("clock-cycle");
  expect(store.isHidden("clock-cycle", owner, serverNow)).toBe(true);
  expect(store.isHidden("clock-cycle", {}, serverNow)).toBe(true);
  const restarted = createStartPlanQuotaReminderStore({ storage: () => localStorage });
  expect(restarted.isHidden("clock-cycle", {}, serverNow)).toBe(true);
  expect(restarted.isHidden("new-cycle", {}, 2100)).toBe(false);
  restarted.markShown("new-cycle", 3000, owner, 2100);
  expect(restarted.isHidden("new-cycle", {}, 2100)).toBe(true);
});
