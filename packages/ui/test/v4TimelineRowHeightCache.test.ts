// M5④ 虚拟滚动核心：v4 timeline 行高缓存单测（纯数据结构）。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";

describe("TimelineRowHeightCache", () => {
  it("未测量行回落估计值；测量后 estimate 返回真实高度（行卸载重挂保缓存）", () => {
    const cache = new TimelineRowHeightCache();
    expect(cache.estimate(1)).toBe(DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
    expect(cache.estimate(1, 100)).toBe(100);

    cache.set(1, 237);
    expect(cache.estimate(1)).toBe(237);
    expect(cache.get(1)).toBe(237);
    // 其他行不受影响
    expect(cache.estimate(2)).toBe(DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
  });

  it("rowId 未知（越界索引）回落估计值", () => {
    const cache = new TimelineRowHeightCache();
    expect(cache.estimate(undefined)).toBe(DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
    expect(cache.estimate(undefined, 48)).toBe(48);
  });

  it("重复写入以最新测量为准（流式行持续长高）", () => {
    const cache = new TimelineRowHeightCache();
    cache.set(7, 72);
    cache.set(7, 340);
    expect(cache.estimate(7)).toBe(340);
    expect(cache.size).toBe(1);
  });

  it("HLP01：以稳定 turnId 缓存，补到更早 header 后仍复用测高", () => {
    const cache = new TimelineRowHeightCache();
    cache.set("turn-long", 480);
    expect(cache.estimate("turn-long")).toBe(480);
  });

  it("拒绝无效高度（0/负数/NaN 不覆盖已有测量）", () => {
    const cache = new TimelineRowHeightCache();
    cache.set(3, 120);
    cache.set(3, 0);
    cache.set(3, -5);
    cache.set(3, Number.NaN);
    expect(cache.estimate(3)).toBe(120);
  });

  it("超上限按写入序淘汰最旧行；重复写入刷新淘汰顺序", () => {
    const cache = new TimelineRowHeightCache(3);
    cache.set(1, 10);
    cache.set(2, 20);
    cache.set(3, 30);
    // 刷新 rowId=1 的活跃度，随后插入第 4 项应淘汰 rowId=2
    cache.set(1, 11);
    cache.set(4, 40);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe(11);
    expect(cache.get(3)).toBe(30);
    expect(cache.get(4)).toBe(40);
    expect(cache.size).toBe(3);
  });

  it("clear 全量重置（会话切换防 rowId 串号）", () => {
    const cache = new TimelineRowHeightCache();
    cache.set(1, 100);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.estimate(1)).toBe(DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
  });

  it("默认上限为常量 MAX_ROW_HEIGHT_CACHE_ENTRIES", () => {
    expect(MAX_ROW_HEIGHT_CACHE_ENTRIES).toBeGreaterThan(0);
  });
});
