import { describe, expect, it } from "vitest";
import {
  aggregateChromiumProcessRoles,
  CHROMIUM_PROCESS_RESOURCE_ROLES,
  classifyChromiumProcessRole,
  type ChromiumProcessRolePids,
} from "@desktop/main/processResourceRoleClassifier";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const MINUTE_MS = 60_000;

function pids(overrides: Partial<ChromiumProcessRolePids> = {}): ChromiumProcessRolePids {
  return {
    mainPid: 1,
    mainWindowRendererPids: new Set([2]),
    guestRendererPids: new Set([3]),
    hostPids: new Set([4]),
    schedulerPids: new Set([5]),
    ...overrides,
  };
}

describe("classifyChromiumProcessRole", () => {
  it("按 spec 顺序归类七个 Chromium 体系角色", () => {
    const snapshot = pids();
    const roleOf = (pid: number, type: string): string =>
      classifyChromiumProcessRole({ pid, type, cpuPercent: 0, rssKb: 0 }, snapshot);

    expect(roleOf(1, "Browser")).toBe("main");
    expect(roleOf(2, "Tab")).toBe("renderer_main");
    expect(roleOf(3, "Tab")).toBe("renderer_guest");
    expect(roleOf(9, "GPU")).toBe("gpu");
    expect(roleOf(4, "Utility")).toBe("host");
    expect(roleOf(5, "Utility")).toBe("scheduler");
    expect(roleOf(99, "Utility")).toBe("chromium_other");
    expect(roleOf(98, "Tab")).toBe("chromium_other");
  });

  it("角色集合是 shared 角色枚举的子集且不含 CLI / MCP 角色", () => {
    expect([...CHROMIUM_PROCESS_RESOURCE_ROLES]).toEqual([
      "main",
      "renderer_main",
      "renderer_guest",
      "gpu",
      "chromium_other",
      "host",
      "scheduler",
    ]);
  });
});

describe("aggregateChromiumProcessRoles", () => {
  it("PRT-003 多进程角色同时给出总量、最大单进程与进程数", () => {
    const aggregates = aggregateChromiumProcessRoles({
      now: NOW,
      pids: pids({ guestRendererPids: new Set([31, 32, 33]) }),
      processes: [
        { pid: 31, type: "Tab", cpuPercent: 1, rssKb: 100 },
        { pid: 32, type: "Tab", cpuPercent: 2, rssKb: 200 },
        { pid: 33, type: "Tab", cpuPercent: 3, rssKb: 300 },
      ],
    });

    expect(aggregates).toEqual([
      {
        role: "renderer_guest",
        cpuPercent: 6,
        rssKbTotal: 600,
        rssKbMaxProcess: 300,
        processCount: 3,
        uptimeMinutes: 0,
      },
    ]);
  });

  it("PRT-005 uptime 取自 creationTime，多进程角色取最大", () => {
    const aggregates = aggregateChromiumProcessRoles({
      now: NOW,
      pids: pids({ guestRendererPids: new Set([31, 32]) }),
      processes: [
        { pid: 1, type: "Browser", cpuPercent: 0, rssKb: 10, creationTime: NOW - 90 * MINUTE_MS },
        { pid: 31, type: "Tab", cpuPercent: 0, rssKb: 10, creationTime: NOW - 10 * MINUTE_MS },
        { pid: 32, type: "Tab", cpuPercent: 0, rssKb: 10, creationTime: NOW - 90 * MINUTE_MS },
      ],
    });

    const byRole = new Map(aggregates.map((item) => [item.role, item]));
    expect(byRole.get("main")?.uptimeMinutes).toBe(90);
    expect(byRole.get("renderer_guest")?.uptimeMinutes).toBe(90);
  });

  it("不返回本 tick 没有存活进程的角色", () => {
    const aggregates = aggregateChromiumProcessRoles({
      now: NOW,
      pids: pids(),
      processes: [{ pid: 1, type: "Browser", cpuPercent: 1, rssKb: 10 }],
    });

    expect(aggregates.map((item) => item.role)).toEqual(["main"]);
  });
});
