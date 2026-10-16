import { describe, expect, it } from "vitest";
import type { ResourceUsageProcess } from "@zcode/shared";
import {
  formatBytes,
  formatPercent,
  groupResourceUsage,
} from "@/resource-manager/resourceUsageView.js";

function process(
  pid: number,
  category: ResourceUsageProcess["category"],
  cpuPercent: number,
  memoryBytes: number,
  sampled = true,
): ResourceUsageProcess {
  return {
    pid,
    name: `p${pid}`,
    category,
    groupKey: "g",
    groupLabel: "g",
    cpuPercent,
    memoryBytes,
    sampled,
  };
}

describe("groupResourceUsage", () => {
  it("固定三组顺序，组内按 CPU/内存降序，小计与未采样标记正确", () => {
    const groups = groupResourceUsage([
      process(3, "community-plugin", 1, 10),
      process(1, "base", 2, 100),
      process(2, "base", 5, 50),
      process(4, "base", 0, 0, false),
    ]);
    expect(groups.map((group) => group.category)).toEqual([
      "base",
      "builtin-plugin",
      "community-plugin",
    ]);
    expect(groups[0]).toMatchObject({
      processCount: 3,
      cpuPercent: 7,
      memoryBytes: 150,
      hasUnsampled: true,
    });
    expect(groups[0]?.processes.map((item) => item.pid)).toEqual([2, 1, 4]);
    expect(groups[1]).toMatchObject({
      processCount: 0,
      cpuPercent: 0,
      memoryBytes: 0,
      hasUnsampled: false,
    });
    expect(groups[2]?.processCount).toBe(1);
  });
});

describe("formatters", () => {
  it("字节按 1024 进制换算并控制小数位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(2.25 * 1024 ** 3)).toBe("2.3 GB");
  });
  it("百分比保留一位小数", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
    expect(formatPercent(Number.NaN)).toBe("0.0%");
  });
});
