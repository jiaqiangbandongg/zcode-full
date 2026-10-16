import { describe, expect, it } from "vitest";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "../src/main/browserView/browserTabResidencyCoordinator.js";
import type { BrowserTabResidencyCandidate } from "../src/main/browserView/browserTabResidencyPolicy.js";

function candidate(
  tabId: string,
  overrides: Partial<BrowserTabResidencyCandidate> = {},
): BrowserTabResidencyCandidate {
  return {
    tabId,
    windowId: 1,
    sessionId: "task-a",
    residency: "live-background",
    guestAttached: true,
    openedAt: 1,
    lastActivityAt: 1,
    lastSelectedAt: null,
    preferred: false,
    currentTask: false,
    selected: false,
    visible: false,
    operationActive: false,
    captureActive: false,
    audible: false,
    mediaActive: false,
    loading: false,
    downloadActive: false,
    ...overrides,
  };
}

describe("BrowserTabResidencyCoordinator", () => {
  it("BTL20: detached/suspended shell 计入逻辑上限，并可作为最老 victim 关闭", async () => {
    const evicted: string[] = [];
    const coordinator = new BrowserTabResidencyCoordinator({
      tabLimit: 2,
      onEvict: async (record) => {
        evicted.push(record.tabId);
        return true;
      },
    });
    coordinator.upsert(
      candidate("browser:ghost", {
        guestAttached: false,
        residency: "suspended",
        openedAt: 0,
        lastActivityAt: 0,
      }),
    );
    coordinator.upsert(candidate("browser:real-old", { openedAt: 1 }));
    coordinator.upsert(candidate("browser:real-new", { openedAt: 2, lastActivityAt: 2 }));

    await coordinator.whenIdle();

    expect(evicted).toEqual(["browser:ghost"]);
    expect(coordinator.get("browser:ghost")).toBeNull();
    expect(coordinator.get("browser:real-new")?.residency).toBe("live-background");
    coordinator.dispose();
  });

  it("同一窗口、同一任务只保留最后选中的 preferred tab", async () => {
    let now = 100;
    const evicted: BrowserTabResidencyRecord[] = [];
    const coordinator = new BrowserTabResidencyCoordinator({
      now: () => now,
      onEvict: async (record) => {
        evicted.push(record);
        return true;
      },
    });
    coordinator.upsert(candidate("browser:a"));
    coordinator.upsert(candidate("browser:b"));

    coordinator.report("browser:a", { selected: true });
    now = 200;
    coordinator.report("browser:b", { selected: true });
    await coordinator.whenIdle();

    expect(coordinator.get("browser:a")?.preferred).toBe(false);
    expect(coordinator.get("browser:b")?.preferred).toBe(true);
    expect(evicted).toEqual([]);
    coordinator.dispose();
  });

  it("不同任务分别保留自己的 preferred tab", async () => {
    const coordinator = new BrowserTabResidencyCoordinator({
      onEvict: async () => true,
    });
    coordinator.upsert(candidate("browser:a", { sessionId: "task-a" }));
    coordinator.upsert(candidate("browser:b", { sessionId: "task-b" }));

    coordinator.report("browser:a", { selected: true });
    coordinator.report("browser:b", { selected: true });
    await coordinator.whenIdle();

    expect(coordinator.get("browser:a")?.preferred).toBe(true);
    expect(coordinator.get("browser:b")?.preferred).toBe(true);
    coordinator.dispose();
  });

  it("运行、捕获与媒体等保护状态开始时会刷新 LRU 活动时间", () => {
    let now = 100;
    const coordinator = new BrowserTabResidencyCoordinator({
      now: () => now,
      onEvict: async () => true,
    });
    coordinator.upsert(candidate("browser:a"));

    for (const patch of [
      { operationActive: true },
      { captureActive: true },
      { audible: true },
      { mediaActive: true },
      { loading: true },
      { downloadActive: true },
    ]) {
      now += 10;
      coordinator.report("browser:a", patch);
      expect(coordinator.get("browser:a")?.lastActivityAt).toBe(now);
    }
    coordinator.dispose();
  });

  it("恢复失败只回滚当前 generation，并推进 generation 拒绝迟到 attach", () => {
    const coordinator = new BrowserTabResidencyCoordinator({
      onEvict: async () => true,
    });
    coordinator.upsert(candidate("browser:a", { residency: "suspended" }));
    const restoring = coordinator.markRestoring("browser:a")!;

    expect(coordinator.failRestore("browser:a", restoring.generation - 1)).toBeNull();
    const failed = coordinator.failRestore("browser:a", restoring.generation)!;

    expect(failed.residency).toBe("suspended");
    expect(failed.loading).toBe(false);
    expect(failed.generation).toBe(restoring.generation + 1);
    coordinator.dispose();
  });

  it("BTL15: durable close 失败时保留 logical tab 并停止本轮重试", async () => {
    const evicted: string[] = [];
    const coordinator = new BrowserTabResidencyCoordinator({
      tabLimit: 0,
      onEvict: async (record) => {
        evicted.push(record.tabId);
        return false;
      },
    });
    coordinator.upsert(candidate("browser:a"));
    await coordinator.whenIdle();

    expect(evicted).toEqual(["browser:a"]);
    expect(coordinator.get("browser:a")?.residency).toBe("live-background");
    coordinator.dispose();
  });
});
