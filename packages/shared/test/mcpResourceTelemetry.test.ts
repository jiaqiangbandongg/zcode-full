import { describe, expect, it } from "vitest";
import { hostResponseMessageSchema, zcodeMcpResourceSamplesSchema } from "@zcode/shared";

const sample = {
  mcpId: "builtin:node_repl",
  instanceToken: "cli-instance-01",
  sampledAt: 300_000,
  intervalMs: 300_000,
  processCount: 2,
  rssKbTotal: 120_000,
  rssKbMaxProcess: 80_000,
  cpuTimeMsDelta: 30_000,
  uptimeMinutes: 5,
  platform: "linux",
  arch: "x64",
  logicalCpuCount: 8,
  totalMemoryGb: 32,
};

describe("MCP 资源通知边界", () => {
  it("PRT-034 Host 可带哈希环境身份，旧 Host 缺字段保持兼容，拒绝原始地址", () => {
    for (const envelope of [
      { type: "mcp-resource-samples", runtimeSurface: "remote", samples: [sample] },
      {
        type: "agent-resource-sample",
        runtimeSurface: "remote",
        sample: {
          platform: "linux",
          arch: "x64",
          logicalCpuCount: 8,
          intervalMs: 60_000,
          cpuCores: 1,
          cpuPercent: 12.5,
          rssKb: 1000,
        },
      },
    ]) {
      expect(hostResponseMessageSchema.safeParse(envelope).success).toBe(true);
      expect(
        hostResponseMessageSchema.safeParse({ ...envelope, environmentKey: "a".repeat(64) })
          .success,
      ).toBe(true);
      expect(
        hostResponseMessageSchema.safeParse({
          ...envelope,
          environmentKey: "ssh:user@private-host",
        }).success,
      ).toBe(false);
    }
  });

  it("接受资源数组与 Host 转发，拒绝隐私字段和非法资源数值", () => {
    expect(zcodeMcpResourceSamplesSchema.parse([sample])).toEqual([sample]);
    expect(
      hostResponseMessageSchema.safeParse({
        type: "mcp-resource-samples",
        runtimeSurface: "remote",
        samples: [sample],
      }).success,
    ).toBe(true);
    for (const extra of [
      { pid: 123 },
      { workspacePath: "/private" },
      { heapUsedKb: 100 },
      { mcpId: "private-name" },
      { intervalMs: 0 },
      { cpuTimeMsDelta: -1 },
      { logicalCpuCount: 0 },
      { rssKbTotal: Infinity },
    ]) {
      expect(zcodeMcpResourceSamplesSchema.safeParse([{ ...sample, ...extra }]).success).toBe(
        false,
      );
    }
  });
});
