/**
 * lineage 活动时长的求和（完成卡的「时间」格，
 * docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
 *
 * 回归的缺陷：时长曾只算「结算它的那个进程自己的那一世」，于是一个跑了四小时、被修订过一次的
 * run 在完成卡上报几秒——resume 与修订各自重开一次进程内时钟，而那一世大半是缓存重放。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { JournalStorePort, RunRecord } from "@zcode/dynamic-workflow";
import type { DwfRunLifeSpan } from "@zcode/adapters/storage";
import { runLineageActiveMs } from "../src/app/dynamic-workflow-run-elapsed.js";
import { resolveDynamicWorkflowJournalStore } from "../src/app/dynamic-workflow-run-journal.js";

/** 只实现被读到的两条：一条读世、一条读 lineage 指针。其余方法一律不该被这条求和碰到。 */
function fakeJournal(input: {
  lives: Record<string, DwfRunLifeSpan[]>;
  resumedFrom?: Record<string, string>;
  omitLifeSpans?: boolean;
}): JournalStorePort & { calls: string[] } {
  const calls: string[] = [];
  const base = {
    calls,
    getRun(runId: string): RunRecord | undefined {
      if (input.lives[runId] === undefined && input.resumedFrom?.[runId] === undefined) {
        return undefined;
      }
      const resumedFrom = input.resumedFrom?.[runId];
      return {
        runId,
        caps: { maxConcurrency: 4 },
        spentTokens: 0,
        status: "completed",
        ...(resumedFrom === undefined ? {} : { resumedFrom }),
      } satisfies RunRecord;
    },
  } as unknown as JournalStorePort & { calls: string[] };
  if (input.omitLifeSpans === true) return base;
  return Object.assign(base, {
    listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
      calls.push(runId);
      return input.lives[runId] ?? [];
    },
  });
}

const HOUR = 3_600_000;

describe("runLineageActiveMs", () => {
  it("单世 run：就是那一世的墙钟", () => {
    const journal = fakeJournal({ lives: { a: [{ startedAt: 1_000, lastActivityAt: 61_000 }] } });

    expect(runLineageActiveMs(journal, "a")).toBe(60_000);
  });

  it("多世 run（resume）：逐世相加，世与世之间的死时间不计", () => {
    const journal = fakeJournal({
      lives: {
        a: [
          { startedAt: 0, lastActivityAt: HOUR },
          // 周末之后才 resume，两分钟后完成。
          { startedAt: 200 * HOUR, lastActivityAt: 200 * HOUR + 120_000 },
        ],
      },
    });

    expect(runLineageActiveMs(journal, "a")).toBe(HOUR + 120_000);
  });

  it("修订链：沿 resumedFrom 上溯，前驱的每一世都算进来", () => {
    // c 修订自 b，b 修订自 a：用户眼里是同一件工作的第三版。
    const journal = fakeJournal({
      lives: {
        a: [{ startedAt: 0, lastActivityAt: 4 * HOUR }],
        b: [{ startedAt: 10 * HOUR, lastActivityAt: 10 * HOUR + HOUR }],
        // 修订出来的这一世几乎全是缓存重放——12 秒。
        c: [{ startedAt: 20 * HOUR, lastActivityAt: 20 * HOUR + 12_000 }],
      },
      resumedFrom: { c: "b", b: "a" },
    });

    expect(runLineageActiveMs(journal, "c")).toBe(4 * HOUR + HOUR + 12_000);
    // 前驱自己的卡不受影响：它只报到自己为止。
    expect(runLineageActiveMs(journal, "b")).toBe(4 * HOUR + HOUR);
    expect(runLineageActiveMs(journal, "a")).toBe(4 * HOUR);
  });

  it("读面不在场（引擎的内存 journal）：undefined，让调用方退回本世", () => {
    const journal = fakeJournal({
      lives: { a: [{ startedAt: 0, lastActivityAt: HOUR }] },
      omitLifeSpans: true,
    });

    expect(runLineageActiveMs(journal, "a")).toBeUndefined();
  });

  it("一世都没有（老 run / 行已清理）：undefined，不是 0", () => {
    const journal = fakeJournal({ lives: {} });

    expect(runLineageActiveMs(journal, "a")).toBeUndefined();
    // 但确有一世、时长不足 1 毫秒时报的是 0——与「说不出」是两件事。
    expect(
      runLineageActiveMs(fakeJournal({ lives: { a: [{ startedAt: 5, lastActivityAt: 5 }] } }), "a"),
    ).toBe(0);
  });

  it("前驱行已被清理：本 run 的世照样算，链在读不到的那一跳自然停下", () => {
    const journal = fakeJournal({
      lives: { c: [{ startedAt: 0, lastActivityAt: 12_000 }] },
      resumedFrom: { c: "gone" },
    });

    expect(runLineageActiveMs(journal, "c")).toBe(12_000);
  });

  it("墙钟倒退的一世钳到 0，不从别的世里减时间", () => {
    const journal = fakeJournal({
      lives: {
        a: [
          { startedAt: 1_000, lastActivityAt: 500 },
          { startedAt: 10_000, lastActivityAt: 70_000 },
        ],
      },
    });

    expect(runLineageActiveMs(journal, "a")).toBe(60_000);
  });

  it("自指与成环的 resumedFrom 不会转不出来，每个 run 只读一次", () => {
    const selfRef = fakeJournal({
      lives: { a: [{ startedAt: 0, lastActivityAt: 1_000 }] },
      resumedFrom: { a: "a" },
    });
    expect(runLineageActiveMs(selfRef, "a")).toBe(1_000);
    expect(selfRef.calls).toEqual(["a"]);

    const cycle = fakeJournal({
      lives: {
        a: [{ startedAt: 0, lastActivityAt: 1_000 }],
        b: [{ startedAt: 0, lastActivityAt: 2_000 }],
      },
      resumedFrom: { a: "b", b: "a" },
    });
    expect(runLineageActiveMs(cycle, "a")).toBe(3_000);
    expect(cycle.calls).toEqual(["a", "b"]);
  });

  it("长链在跳数上限处停下（读一个时长不该扫过任意多行）", () => {
    const lives: Record<string, DwfRunLifeSpan[]> = {};
    const resumedFrom: Record<string, string> = {};
    // 200 跳的链：上限 64，所以求和到第 64 跳为止。
    for (let index = 0; index < 200; index += 1) {
      lives[`r${index}`] = [{ startedAt: 0, lastActivityAt: 1_000 }];
      resumedFrom[`r${index}`] = `r${index + 1}`;
    }
    const journal = fakeJournal({ lives, resumedFrom });

    expect(runLineageActiveMs(journal, "r0")).toBe(64_000);
    expect(journal.calls).toHaveLength(64);
  });
});

/**
 * 生产接线的绊线（与本文件上方的单测互补）：走真实的 sqlite session store，即生产那条
 * `resolveDynamicWorkflowJournalStore` 路径。
 *
 * 读面是**能力探测**出来的（它不在引擎的 `JournalStorePort` 上），所以方法名或签名一旦漂移，
 * 不会有任何编译错误——只会让时长静默退回「本世」，也就是退回被修的那个 bug。
 *
 * 时刻由 `appendEvent` 打 `Date.now()`，所以这里只假 `Date`（不动定时器：store 自己可能排程），
 * 让一条「跑一小时 → 被重启打断 → 两天后 resume → 两分钟后完成」的 run 在毫秒上完全确定。
 */
describe("runLineageActiveMs — 对着真实 sqlite journal", () => {
  const CAPS = { maxConcurrency: 4 };
  const T0 = Date.UTC(2026, 8, 18, 9, 0, 0);

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 在给定时刻追加一条事件。 */
  function appendAt(
    journal: JournalStorePort,
    runId: string,
    at: number,
    event: "start" | "log" | "settle",
  ): void {
    vi.setSystemTime(at);
    journal.appendEvent(
      runId,
      event === "start"
        ? { type: "run-started", runId, caps: CAPS }
        : event === "log"
          ? { type: "log", message: "工作中" }
          : { type: "run-settled", status: "completed" },
    );
  }

  it("多世 + 修订链：真库上的求和只算活着的那几段", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-elapsed-"));
    const store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const journal = resolveDynamicWorkflowJournalStore(store as never);
      expect(journal).toBeDefined();
      vi.useFakeTimers({ toFake: ["Date"] });

      // 前驱：第一世跑满一小时后进程死掉（没有 run-settled），两天后 resume，两分钟后完成。
      journal!.createRun({ runId: "dwfrun-pred", caps: CAPS, spentTokens: 0, status: "running" });
      appendAt(journal!, "dwfrun-pred", T0, "start");
      appendAt(journal!, "dwfrun-pred", T0 + 3_600_000, "log");
      appendAt(journal!, "dwfrun-pred", T0 + 48 * 3_600_000, "start");
      appendAt(journal!, "dwfrun-pred", T0 + 48 * 3_600_000 + 120_000, "settle");

      // 修订：新 runId、resumedFrom 指向前驱，这一世 12 秒（几乎全是缓存重放）。
      journal!.createRun({
        runId: "dwfrun-amended",
        caps: CAPS,
        spentTokens: 0,
        status: "running",
        resumedFrom: "dwfrun-pred",
      });
      appendAt(journal!, "dwfrun-amended", T0 + 72 * 3_600_000, "start");
      appendAt(journal!, "dwfrun-amended", T0 + 72 * 3_600_000 + 12_000, "settle");

      // 前驱自己：一小时 + 两分钟（两世之间那 47 小时死时间不计）。
      expect(runLineageActiveMs(journal!, "dwfrun-pred")).toBe(3_600_000 + 120_000);
      // 修订：整条 lineage。被修的 bug 会在这里报 12_000。
      expect(runLineageActiveMs(journal!, "dwfrun-amended")).toBe(3_600_000 + 120_000 + 12_000);
    } finally {
      vi.useRealTimers();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
