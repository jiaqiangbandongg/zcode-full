import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestMcpResourceSamples,
  mcpProcessResourceSampleSource as source,
} from "@desktop/main/processResourceMcpTelemetrySource";
import {
  collectExternalAppResourceTotals,
  resetExternalAppResourceSamples,
} from "@desktop/main/processResourceExternalAppSamples";
import type { ProcessRoleSample } from "@desktop/main/processResourceWindowAggregator";
import type { ZCodeMcpResourceSample } from "@zcode/shared";

const debug = vi.hoisted(() => vi.fn());
vi.mock("@desktop/main/logger", () => ({ logger: { debug } }));
function sample(overrides: Partial<ZCodeMcpResourceSample> = {}): ZCodeMcpResourceSample {
  return {
    mcpId: "builtin:node_repl",
    instanceToken: "cli-instance-01",
    sampledAt: 300000,
    intervalMs: 300000,
    processCount: 2,
    rssKbTotal: 120000,
    rssKbMaxProcess: 80000,
    cpuTimeMsDelta: 30000,
    uptimeMinutes: 5,
    platform: "linux",
    arch: "x64",
    logicalCpuCount: 8,
    totalMemoryGb: 32,
    ...overrides,
  };
}
function flush() {
  const roles: ProcessRoleSample[] = [];
  source.flushPending?.({
    now: Date.now(),
    addRoleSample: (role) => roles.push(role),
    addRoleHeapSample: vi.fn(),
    addAppProcessTotals: vi.fn(),
  });
  return roles;
}
function tick() {
  source.sample?.({
    now: Date.now(),
    addRoleSample: vi.fn(),
    addRoleHeapSample: vi.fn(),
    addAppProcessTotals: vi.fn(),
  });
  return collectExternalAppResourceTotals(Date.now());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
  source.reset?.();
  resetExternalAppResourceSamples();
});
afterEach(() => {
  source.reset?.();
  resetExternalAppResourceSamples();
  vi.useRealTimers();
});

describe("MCP 资源窗口来源", () => {
  it("PRT-034 同硬件不同环境不相加，同环境两个实例仍合计", () => {
    const first = sample({ cpuTimeMsDelta: 1_920_000, rssKbTotal: 500_000, processCount: 1 });
    const environmentA = "a".repeat(64);
    const environmentB = "b".repeat(64);
    ingestMcpResourceSamples([first], "remote", environmentA);
    ingestMcpResourceSamples([first], "remote", environmentB);
    ingestMcpResourceSamples([first], "remote", environmentA);
    const roles = flush();
    expect(roles).toHaveLength(2);
    expect(roles.map((role) => role.environmentKey)).toEqual([environmentA, environmentB]);
    expect(
      roles.every(
        (role) => role.cpuPercent === 80 && role.rssKbTotal === 500_000 && role.processCount === 1,
      ),
    ).toBe(true);
    ingestMcpResourceSamples(
      [sample({ instanceToken: "cli-instance-02" })],
      "remote",
      environmentA,
    );
    expect(flush()).toMatchObject([
      { environmentKey: environmentA, processCount: 3, rssKbTotal: 620_000 },
    ]);
  });
  it("33 个 MCP ID 只交出 32 条并记 debug，下个窗口恢复额度", () => {
    const samples = Array.from({ length: 33 }, (_, index) =>
      sample({ mcpId: `builtin:mcp-${index}` }),
    );
    ingestMcpResourceSamples(samples, "local");
    expect(flush()).toHaveLength(32);
    expect(debug).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("32"));
    expect(flush()).toEqual([]);
    ingestMcpResourceSamples([sample({ mcpId: "builtin:mcp-32", sampledAt: 600000 })], "local");
    expect(flush()).toMatchObject([{ mcpId: "builtin:mcp-32" }]);
  });
  it("同机同 ID 的两个 CLI 合计，重复和乱序通知不能双计或覆盖", () => {
    const first = sample();
    const second = sample({
      instanceToken: "cli-instance-02",
      rssKbTotal: 200000,
      rssKbMaxProcess: 150000,
      processCount: 3,
    });
    ingestMcpResourceSamples([first, second], "local");
    ingestMcpResourceSamples([first, sample({ sampledAt: 299999, rssKbTotal: 999999 })], "local");
    expect(flush()).toMatchObject([
      { processCount: 5, rssKbTotal: 320000, rssKbMaxProcess: 150000, cpuPercent: 2.5 },
    ]);
    ingestMcpResourceSamples([first, second], "local");
    expect(flush()).toEqual([]);
  });
  it("设备总量包含本机最近 RSS，远端不计入，600 秒后过期", () => {
    ingestMcpResourceSamples([sample()], "local");
    ingestMcpResourceSamples([sample({ rssKbTotal: 999999 })], "remote");
    expect(tick()).toMatchObject({ rssKbTotal: 120000, processCount: 2 });
    vi.setSystemTime(600000);
    expect(tick()).toMatchObject({ rssKbTotal: 120000 });
    vi.setSystemTime(600001);
    expect(tick()).toMatchObject({ rssKbTotal: 0, processCount: 0 });
    expect(flush()).toEqual([]);
  });
  it("本窗口没有新样本或输入非法就没有 MCP 事件，其他来源不参与", () => {
    ingestMcpResourceSamples([{ ...sample(), pid: 123 }], "local");
    expect(flush()).toEqual([]);
    ingestMcpResourceSamples([sample()], "local");
    expect(flush()).toHaveLength(1);
    vi.setSystemTime(300000);
    expect(flush()).toEqual([]);
  });
});
