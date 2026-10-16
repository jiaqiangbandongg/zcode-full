import { describe, expect, it } from "vitest";
import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  memoryUsageToSampleFields,
  type MemorySample,
} from "../src/memoryDiagnostics.js";

const base: MemorySample = {
  role: "main",
  rssKb: 400_000,
  heapUsedKb: 100_000,
  counters: { "app.windows": 2, "taskBus.leases": 0 },
};

describe("createMemorySampleWriteGate", () => {
  it("MEM-001 首次采样必写", () => {
    const gate = createMemorySampleWriteGate();
    expect(gate.evaluate(base, 0)).toBe("first");
  });

  it("MEM-002 heap 变化不超过 5% 且计数器不变时不写", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate({ ...base, heapUsedKb: 104_000 }, 60_000)).toBeNull();
    expect(gate.evaluate({ ...base, heapUsedKb: 96_000 }, 120_000)).toBeNull();
  });

  it("MEM-002b heap 不动但 rss 或 external 变化超过 10% 时写 changed（真机 host RSS 冲到 1.5GB 的场景）", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate({ ...base, externalKb: 18_000 }, 0);
    expect(gate.evaluate({ ...base, rssKb: 436_000, externalKb: 18_000 }, 60_000)).toBeNull();
    expect(gate.evaluate({ ...base, rssKb: 1_534_000, externalKb: 18_000 }, 120_000)).toBe("changed");
    expect(gate.evaluate({ ...base, rssKb: 1_534_000, externalKb: 1_328_000 }, 180_000)).toBe(
      "changed",
    );
  });

  it("MEM-003 heap 相对上一次写盘值变化超过 5% 时写 changed，且基线更新为本次值", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate({ ...base, heapUsedKb: 106_000 }, 60_000)).toBe("changed");
    // 相对新基线 106000 只涨 3%，不写。
    expect(gate.evaluate({ ...base, heapUsedKb: 109_000 }, 120_000)).toBeNull();
  });

  it("MEM-004 任一计数器变化（含新增/消失的 key）时写 changed", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(
      gate.evaluate({ ...base, counters: { ...base.counters, "taskBus.leases": 1 } }, 60_000),
    ).toBe("changed");
    expect(gate.evaluate({ ...base, counters: { "app.windows": 2 } }, 120_000)).toBe("changed");
  });

  it("MEM-005 全部不变时每 5 分钟写一次 heartbeat，并重新计时", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate(base, 240_000)).toBeNull();
    expect(gate.evaluate(base, 300_000)).toBe("heartbeat");
    expect(gate.evaluate(base, 360_000)).toBeNull();
    expect(gate.evaluate(base, 600_000)).toBe("heartbeat");
  });

  it("renderer 没有 heapUsed 以外的字段时仍按计数器与心跳门控", () => {
    const gate = createMemorySampleWriteGate();
    const sample: MemorySample = { role: "renderer", counters: { "shiki.tokensCache": 1 } };
    expect(gate.evaluate(sample, 0)).toBe("first");
    expect(gate.evaluate(sample, 60_000)).toBeNull();
    expect(gate.evaluate({ ...sample, counters: { "shiki.tokensCache": 2 } }, 120_000)).toBe(
      "changed",
    );
  });
});

describe("formatMemorySampleLine", () => {
  it("固定字段在前、计数器按字典序、全部取整、缺失字段省略", () => {
    const line = formatMemorySampleLine(
      {
        role: "renderer",
        heapUsedKb: 1234.6,
        counters: { "zeta.b": 2, "alpha.a": 1.4, "alpha.nan": Number.NaN },
      },
      "changed",
    );
    expect(line).toBe("[memory] role=renderer reason=changed heapUsedKb=1235 alpha.a=1 zeta.b=2");
  });
});

describe("memoryUsageToSampleFields", () => {
  it("把字节换算成取整 KB，缺失字段省略", () => {
    expect(memoryUsageToSampleFields({ rss: 2048, heapUsed: 1536, heapTotal: 4096 })).toEqual({
      rssKb: 2,
      heapUsedKb: 2,
      heapTotalKb: 4,
    });
  });
});

describe("createMemoryDiagnosticsRegistry", () => {
  it("MEM-006 provider 抛错只跳过自己，键带 provider 前缀，非数值丢弃", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("ok", () => ({ size: 3, bad: Number.POSITIVE_INFINITY }));
    registry.register("boom", () => {
      throw new Error("read failed");
    });
    expect(registry.collect()).toEqual({ "ok.size": 3 });
  });

  it("dispose 只移除仍属于自己的注册；同名后注册者覆盖前者", () => {
    const registry = createMemoryDiagnosticsRegistry();
    const first = registry.register("x", () => ({ v: 1 }));
    registry.register("x", () => ({ v: 2 }));
    first.dispose();
    expect(registry.collect()).toEqual({ "x.v": 2 });
  });
});
