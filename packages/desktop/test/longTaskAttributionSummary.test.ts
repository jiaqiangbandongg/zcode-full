import { describe, expect, it } from "vitest";
import { summarizeLongTaskAttribution } from "../src/main/longTaskAttributionSummary.js";

describe("summarizeLongTaskAttribution", () => {
  it("提炼耗时最长的 attribution 作为 top,并计算占比", () => {
    const snapshots = JSON.stringify([
      { duration: 40, invokerType: "event-listener" },
      { duration: 120, invokerType: "user-callback" },
      { duration: 10, invokerType: "user-callback" },
    ]);
    const result = summarizeLongTaskAttribution(snapshots, 200);
    expect(result).toEqual({
      loaf_script_count: 3,
      loaf_top_duration_ms: 120,
      loaf_top_invoker_type: "user-callback",
      loaf_top_share_pct: 60,
    });
  });

  it("snapshots 为空字符串时返回 null", () => {
    expect(summarizeLongTaskAttribution("", 200)).toBeNull();
  });

  it("snapshots 为 '[]' 时返回 null", () => {
    expect(summarizeLongTaskAttribution("[]", 200)).toBeNull();
  });

  it("snapshots 非法 JSON 时返回 null", () => {
    expect(summarizeLongTaskAttribution("{not valid json", 200)).toBeNull();
  });

  it("snapshots 为 undefined 时返回 null", () => {
    expect(summarizeLongTaskAttribution(undefined, 200)).toBeNull();
  });

  it("invokerType 缺失时归一化为 script(rAF 来源)", () => {
    const snapshots = JSON.stringify([{ duration: 50, containerType: "iframe" }]);
    const result = summarizeLongTaskAttribution(snapshots, 100);
    expect(result?.loaf_top_invoker_type).toBe("script");
  });

  it("invokerType 为非法枚举值时归一化为 unknown", () => {
    const snapshots = JSON.stringify([{ duration: 50, invokerType: "weird-value" }]);
    const result = summarizeLongTaskAttribution(snapshots, 100);
    expect(result?.loaf_top_invoker_type).toBe("unknown");
  });

  it("totalDurationMs 为 0/负数/非数字时 share 记 0,其它字段仍正常", () => {
    const snapshots = JSON.stringify([{ duration: 50, invokerType: "user-callback" }]);
    for (const total of [0, -10, Number.NaN, "not-a-number", undefined]) {
      const result = summarizeLongTaskAttribution(snapshots, total);
      expect(result).not.toBeNull();
      expect(result?.loaf_top_share_pct).toBe(0);
      expect(result?.loaf_top_duration_ms).toBe(50);
    }
  });
});
