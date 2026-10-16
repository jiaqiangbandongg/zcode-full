/**
 * ConcurrencyController 的纯状态机用例（docs/dynamic-workflow/concurrency.md「The controller」
 * 的两行控制器用例）。无时钟：`now` 由用例传入。度量是模型请求（决策 34），阻尼靠 epoch（决策 35），
 * 减系数 0.75、K = 4、lastGood 只由完成的 streak 设定（决策 40）。
 */

import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  ConcurrencyController,
} from "../../src/engine/index.js";

const KEY = "anthropic/claude";
const K = CONCURRENCY_INCREASE_AFTER_SUCCESSES;
const T0 = 1_000_000;

/** 准入 n 个请求，返回它们的 epoch。 */
function admit(c: ConcurrencyController, n: number, now = T0): number[] {
  const epochs: number[] = [];
  for (let i = 0; i < n; i++) epochs.push(c.admitted(now));
  return epochs;
}

/** 准入 n 个请求并让它们全部在当前 epoch 成功；返回期间产生的全部 change。 */
function roundTrip(c: ConcurrencyController, n: number, now = T0) {
  const changes = [];
  for (let i = 0; i < n; i++) {
    const epoch = c.admitted(now);
    changes.push(...c.succeeded(now, epoch));
  }
  return changes;
}

/** 一个当前 epoch 的 429（先准入再限流）。 */
function throttleNow(c: ConcurrencyController, reason: "rate_limited" | "provider_overloaded" | "offpeak_queued" = "rate_limited", retryAfterMs?: number, now = T0) {
  const epoch = c.admitted(now);
  return c.throttled(now, epoch, reason, retryAfterMs);
}

describe("ConcurrencyController — 常量（决策 40）", () => {
  it("减系数 0.75、每级 4 次成功", () => {
    expect(CONCURRENCY_DECREASE_FACTOR).toBe(0.75);
    expect(K).toBe(4);
  });
});

describe("ConcurrencyController — 减（决策 4/6/11/35/40）", () => {
  it("当前 epoch 的限流 → cap × 0.75 向下取整并翻 epoch；反复限流一路减到地板 1", () => {
    const c = new ConcurrencyController(KEY, 16);
    expect(c.snapshot().epoch).toBe(0);
    // 减 cap 不设 lastGood（未被证明），只记 lastBad = 撞墙时的 cap。
    expect(throttleNow(c)).toEqual([{ key: KEY, previous: 16, next: 12, reason: "rate_limited", lastBad: 16 }]);
    expect(c.snapshot()).toMatchObject({ epoch: 1, lastBad: 16 });
    expect(c.snapshot().lastGood).toBeUndefined();
    for (const expected of [9, 6, 4, 3, 2, 1]) {
      const [change] = throttleNow(c, "provider_overloaded");
      expect(change?.next).toBe(expected);
    }
    expect(c.snapshot()).toMatchObject({ cap: CONCURRENCY_FLOOR, epoch: 7, inFlight: 0, lastBad: 2 });
    // 地板上再限流：cap 不变、无 Retry-After ⇒ 不发事件，但仍翻一页（同一批请求只裁决一次）。
    expect(throttleNow(c)).toEqual([]);
    expect(c.snapshot().epoch).toBe(8);
  });

  it("同一批 13 个同 epoch 的 429 只减一次、只发一条事件；其余只清 streak、减 inFlight", () => {
    const c = new ConcurrencyController(KEY, 13);
    const epochs = admit(c, 13);
    expect(new Set(epochs)).toEqual(new Set([0]));
    expect(c.snapshot().inFlight).toBe(13);
    const changes = [];
    for (const epoch of epochs) changes.push(...c.throttled(T0, epoch, "rate_limited"));
    expect(changes).toEqual([{ key: KEY, previous: 13, next: 9, reason: "rate_limited", lastBad: 13 }]);
    expect(c.snapshot()).toMatchObject({ cap: 9, epoch: 1, inFlight: 0, successStreak: 0 });
  });

  it("旧 epoch 的 429 不动 cap、不发事件，但清 streak、减 inFlight、刷新 cooldown", () => {
    const c = new ConcurrencyController(KEY, 8);
    const stale = admit(c, 3); // epoch 0
    throttleNow(c); // 8→6, epoch 1
    c.waiters(T0, 1);
    roundTrip(c, K - 1); // 当前 epoch 的成功：streak K−1（还差一次兑现）
    expect(c.snapshot()).toMatchObject({ cap: 6, successStreak: K - 1, inFlight: 3 });
    expect(c.throttled(T0, stale[0]!, "rate_limited", 9_000)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 6, epoch: 1, successStreak: 0, inFlight: 2, cooldownUntil: T0 + 9_000 });
    // 更早的 Retry-After 不会把 cooldown 往前拉。
    expect(c.throttled(T0, stale[1]!, "rate_limited", 1_000)).toEqual([]);
    expect(c.snapshot().cooldownUntil).toBe(T0 + 9_000);
  });

  it("下一次裁决必须来自新 cap 下发出的请求：旧 epoch 全部撞墙后，新 epoch 的 429 才再减", () => {
    const c = new ConcurrencyController(KEY, 13);
    const stale = admit(c, 13);
    for (const epoch of stale) c.throttled(T0, epoch, "rate_limited"); // 13→9 一次
    expect(c.snapshot().cap).toBe(9);
    expect(throttleNow(c)).toEqual([{ key: KEY, previous: 9, next: 6, reason: "rate_limited", lastBad: 9 }]);
  });

  it("Retry-After 冻结新准入直到 deadline；地板上带 Retry-After 的限流仍发事件", () => {
    const c = new ConcurrencyController(KEY, 4);
    const [change] = throttleNow(c, "rate_limited", 20_000);
    expect(change).toMatchObject({ previous: 4, next: 3, cooldownMs: 20_000 });
    expect(c.canAdmit(T0 + 19_999)).toBe(false);
    expect(c.canAdmit(T0 + 20_000)).toBe(true);
    throttleNow(c, "rate_limited", undefined, T0 + 20_000); // 3→2
    throttleNow(c, "rate_limited", undefined, T0 + 20_000); // 2→1
    expect(c.snapshot().cap).toBe(1);
    expect(throttleNow(c, "offpeak_queued", 5_000, T0 + 20_001)).toEqual([
      { key: KEY, previous: 1, next: 1, reason: "offpeak_queued", lastBad: 1, cooldownMs: 5_000 },
    ]);
  });

  it("canAdmit 在 inFlight ≥ cap 时为假，release 后为真", () => {
    const c = new ConcurrencyController(KEY, 2);
    const [a, b] = admit(c, 2);
    expect(c.canAdmit(T0)).toBe(false);
    c.succeeded(T0, a!);
    expect(c.canAdmit(T0)).toBe(true);
    c.ended(T0);
    expect(c.snapshot().inFlight).toBe(0);
    void b;
  });

  it("瞬态非限流失败只清 streak、减 inFlight，cap 不动", () => {
    const c = new ConcurrencyController(KEY, 8);
    c.waiters(T0, 1);
    roundTrip(c, K - 1);
    admit(c, 1);
    expect(c.snapshot()).toMatchObject({ successStreak: K - 1, inFlight: 1 });
    expect(c.failedTransient(T0)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 8, successStreak: 0, inFlight: 0, epoch: 0 });
  });

  it("ended 只减 inFlight", () => {
    const c = new ConcurrencyController(KEY, 8);
    c.waiters(T0, 1);
    roundTrip(c, K - 1);
    admit(c, 2);
    expect(c.ended(T0)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ successStreak: K - 1, inFlight: 1, cap: 8 });
  });
});

describe("ConcurrencyController — 增（决策 4/15/33/35/40）", () => {
  function lowered(): ConcurrencyController {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c); // cap 12, lastBad 16, lastGood 缺席, epoch 1
    return c;
  }

  it("K 次当前 epoch 的连续成功证明当前 cap（lastGood = cap），有等待者才 +1", () => {
    const c = lowered();
    c.waiters(T0, 1);
    expect(roundTrip(c, K - 1)).toEqual([]);
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(roundTrip(c, 1)).toEqual([{ key: KEY, previous: 12, next: 13, reason: "recovered", lastGood: 12, lastBad: 16 }]);
    expect(c.snapshot().successStreak).toBe(0);
  });

  it("无等待者时 streak 照累积、lastGood 照证明，但 cap 不兑现；等待者出现后下一次成功即兑现", () => {
    const c = lowered();
    c.waiters(T0, 0);
    expect(roundTrip(c, K)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 12, successStreak: K, lastGood: 12 });
    c.waiters(T0, 1);
    expect(roundTrip(c, 1)[0]?.next).toBe(13);
  });

  it("旧 epoch 的成功不计 streak（减 cap 后仍在飞的那批请求跑完不算证据）", () => {
    const c = new ConcurrencyController(KEY, 32);
    c.waiters(T0, 3);
    const stale = admit(c, 32);
    c.throttled(T0, stale[0]!, "rate_limited"); // cap 24, epoch 1
    for (const epoch of stale.slice(1)) expect(c.succeeded(T0, epoch)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 24, successStreak: 0, inFlight: 0 });
    expect(c.snapshot().lastGood).toBeUndefined();
    // 新 epoch 的 K 次成功才兑现。
    expect(roundTrip(c, K)[0]?.next).toBe(25);
  });

  it("永不越过天花板；天花板上的完整 streak 仍把它证明为 lastGood", () => {
    const c = new ConcurrencyController(KEY, 2);
    throttleNow(c); // cap 1
    c.waiters(T0, 1);
    const changes = roundTrip(c, K * 3);
    expect(changes.map((x) => x.next)).toEqual([2]);
    expect(c.snapshot()).toMatchObject({ cap: 2, lastGood: 2 });
  });
});

describe("ConcurrencyController — 记住可用水位（决策 22/40）", () => {
  /** 从 cap 16 减到 12，再一路爬到 target（每级 K 次成功）。 */
  function climbTo(target: number): ConcurrencyController {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c);
    c.waiters(T0, 1);
    while (c.snapshot().cap < target) roundTrip(c, K);
    return c;
  }

  it("lastGood 之上被限流 → 退回 lastGood 并记 lastBad，不按系数减，仍翻 epoch", () => {
    const c = climbTo(14);
    expect(c.snapshot()).toMatchObject({ cap: 14, lastGood: 13, epoch: 1 });
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 14, next: 13, reason: "rate_limited", lastGood: 13, lastBad: 14 },
    ]);
    expect(c.snapshot().epoch).toBe(2);
  });

  it("lastGood 及以下被限流 → 墙下移：按系数减、清掉 lastGood（已证伪）、记 lastBad", () => {
    const c = climbTo(14);
    throttleNow(c); // 回 13
    expect(throttleNow(c)).toEqual([{ key: KEY, previous: 13, next: 9, reason: "rate_limited", lastBad: 13 }]);
    expect(c.snapshot().lastGood).toBeUndefined();
  });

  it("每级需 K 次成功（K−1 次不够）；新 cap 要靠自己的 streak 重新证明", () => {
    const c = climbTo(14);
    throttleNow(c); // 14 > lastGood 13 ⇒ 回 13
    expect(throttleNow(c)[0]).toMatchObject({ previous: 13, next: 9 });
    expect(roundTrip(c, K - 1)).toEqual([]);
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(roundTrip(c, 1)[0]).toMatchObject({ next: 10, lastGood: 9 });
    const small = new ConcurrencyController(KEY, 6);
    throttleNow(small); // cap 4, lastBad 6
    small.waiters(T0, 1);
    roundTrip(small, K); // cap 5, lastGood 4
    roundTrip(small, K); // cap 6, lastGood 5
    throttleNow(small); // 6 > lastGood 5 ⇒ 回 5，lastBad 6
    expect(small.snapshot()).toMatchObject({ cap: 5, lastGood: 5, lastBad: 6 });
  });

  it("真实上限 5、天花板 13：13 →429→ 9 →429→ 6 →429→ 4 → 5 → 6 →429→ 5，稳定在 5", () => {
    const c = new ConcurrencyController(KEY, 13);
    c.waiters(T0, 1);
    expect(throttleNow(c)[0]?.next).toBe(9);
    expect(throttleNow(c)[0]?.next).toBe(6);
    expect(throttleNow(c)[0]?.next).toBe(4);
    expect(roundTrip(c, K)[0]).toMatchObject({ next: 5, lastGood: 4 });
    expect(roundTrip(c, K)[0]).toMatchObject({ next: 6, lastGood: 5 });
    expect(throttleNow(c)[0]).toMatchObject({ previous: 6, next: 5, lastGood: 5, lastBad: 6 });
    // 此后每 K 次成功探一次 6，每次只花一个 429、退回 5。
    for (let round = 0; round < 3; round++) {
      expect(roundTrip(c, K)[0]?.next).toBe(6);
      expect(throttleNow(c)[0]).toMatchObject({ previous: 6, next: 5, lastBad: 6 });
    }
    expect(c.snapshot()).toMatchObject({ cap: 5, lastGood: 5, lastBad: 6 });
  });
});

describe("ConcurrencyController — 空闲重置（决策 20）", () => {
  it("空闲 5 分钟且无在飞时，任一信号先重置到天花板并清空 lastGood/lastBad/cooldown，翻 epoch", () => {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c, "rate_limited", 60_000); // cap 12, epoch 1, inFlight 0
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later - 1)).toEqual([]);
    expect(c.observe(later)).toEqual([{ key: KEY, previous: 12, next: 16, reason: "idle_reset" }]);
    expect(c.snapshot()).toMatchObject({ cap: 16, successStreak: 0, epoch: 2 });
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(c.snapshot().lastBad).toBeUndefined();
    expect(c.snapshot().cooldownUntil).toBeUndefined();
    // 重置是幂等的：再来一个空闲信号不再发事件、不再翻页。
    expect(c.observe(later + 1)).toEqual([]);
    expect(c.snapshot().epoch).toBe(2);
  });

  it("有在飞时不重置", () => {
    const c = new ConcurrencyController(KEY, 16);
    admit(c, 1);
    throttleNow(c); // inFlight 1
    expect(c.observe(T0 + CONCURRENCY_IDLE_RESET_MS * 2)).toEqual([]);
    expect(c.snapshot().cap).toBe(12);
  });

  it("重置后从天花板起步的第一次 429 按系数减（lastGood 已清空）；重置与限流在同一信号里是两条 change", () => {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    // 治理器的准入路径：observe（重置）→ admitted → …；这里模拟一个跳过 observe 直接带旧 epoch 来的 429：
    // idleReset 先翻页，所以它按旧 epoch 处理——不减，只有 idle_reset 一条。
    const epoch = c.admitted(T0);
    c.ended(T0);
    expect(c.throttled(later, epoch, "rate_limited")).toEqual([
      { key: KEY, previous: 12, next: 16, reason: "idle_reset" },
    ]);
    // 走正规路径：observe 之后准入再限流，才是对天花板的评价。
    expect(c.observe(later)).toEqual([]);
    expect(throttleNow(c, "rate_limited", undefined, later)).toEqual([
      { key: KEY, previous: 16, next: 12, reason: "rate_limited", lastBad: 16 },
    ]);
  });
});

describe("ConcurrencyController — 增长上限（docs/dynamic-workflow/concurrency.md「Increase」「The governor」）", () => {
  it("起点是 initial；自动增长越过 initial、停在 growthLimit；完整 streak 仍把 growthLimit 证明为 lastGood", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    expect(c.snapshot()).toMatchObject({ initial: 4, growthLimit: 8, cap: 4 });
    c.waiters(T0, 1);
    const changes = roundTrip(c, K * 10);
    expect(changes.map((x) => x.next)).toEqual([5, 6, 7, 8]);
    expect(changes.every((x) => x.reason === "recovered")).toBe(true);
    expect(c.snapshot()).toMatchObject({ cap: 8, lastGood: 8 });
  });

  it("缺省 growthLimit = initial：与从前「天花板即上界」逐字相同", () => {
    const c = new ConcurrencyController(KEY, 6);
    expect(c.snapshot()).toMatchObject({ initial: 6, growthLimit: 6 });
    c.waiters(T0, 1);
    expect(roundTrip(c, K * 3)).toEqual([]);
  });

  it("抬高增长上限不立刻动 cap、不发事件；cap 此后一级一级爬上去", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    expect(c.setGrowthLimit(T0, 20)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 20, cap: 4 });
    c.waiters(T0, 1);
    expect(roundTrip(c, K * 20).map((x) => x.next)).toEqual(
      Array.from({ length: 16 }, (_, i) => 5 + i),
    );
    expect(c.snapshot().cap).toBe(20);
  });

  it("压低到 cap 之下：cap 当场拉到新上限、发 limit_lowered、lastGood 夹到上限、清 streak、翻 epoch", () => {
    const c = new ConcurrencyController(KEY, 4, 20);
    c.waiters(T0, 1);
    roundTrip(c, K * 12); // cap 16，lastGood 15
    expect(c.snapshot().cap).toBe(16);
    roundTrip(c, 2); // streak 2
    const stale = c.admitted(T0); // 旧 cap 下发出的请求
    const epochBefore = c.snapshot().epoch;
    expect(c.setGrowthLimit(T0, 8)).toEqual([
      { key: KEY, previous: 16, next: 8, reason: "limit_lowered", lastGood: 8 },
    ]);
    expect(c.snapshot()).toMatchObject({
      growthLimit: 8,
      cap: 8,
      lastGood: 8,
      successStreak: 0,
      epoch: epochBefore + 1,
    });
    // 那个旧 cap 下发出的请求撞 429：不是对新 cap 的裁决，不再减。
    expect(c.throttled(T0, stale, "rate_limited")).toEqual([]);
    expect(c.snapshot().cap).toBe(8);
  });

  it("压低但 cap 本就不高于新上限：不动 cap、不发事件、不翻 epoch", () => {
    const c = new ConcurrencyController(KEY, 4, 20);
    const epoch = c.snapshot().epoch;
    expect(c.setGrowthLimit(T0, 8)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 8, cap: 4, epoch });
  });

  it("增长上限永不低于 initial", () => {
    const c = new ConcurrencyController(KEY, 6, 12);
    expect(c.setGrowthLimit(T0, 2)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 6, cap: 6 });
  });

  it("空闲重置回 initial，而不是回增长上限", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    c.waiters(T0, 1);
    roundTrip(c, K * 10); // cap 8
    c.waiters(T0, 0);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later)).toEqual([{ key: KEY, previous: 8, next: 4, reason: "idle_reset" }]);
    expect(c.snapshot()).toMatchObject({ cap: 4, growthLimit: 8 });
    expect(c.snapshot().lastGood).toBeUndefined();
  });
});

describe("ConcurrencyController — 抬高上界时直接起跳（seed，docs/dynamic-workflow/concurrency.md「Seeding」）", () => {
  it("seed 把 cap 当场拉到目标（不超过增长上限），发 seeded，清 lastGood、清 streak、翻 epoch", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    c.waiters(T0, 1);
    roundTrip(c, K + 2); // cap 9，lastGood 8，streak 2
    const epoch = c.snapshot().epoch;
    expect(c.seed(T0, 32)).toEqual([{ key: KEY, previous: 9, next: 32, reason: "seeded" }]);
    expect(c.snapshot()).toMatchObject({ cap: 32, successStreak: 0, epoch: epoch + 1 });
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(c.snapshot().lastBad).toBeUndefined();
  });

  it("目标超过增长上限时只跳到增长上限", () => {
    const c = new ConcurrencyController(KEY, 8, 20);
    expect(c.seed(T0, 50)).toEqual([{ key: KEY, previous: 8, next: 20, reason: "seeded" }]);
  });

  it("目标不高于 cap：什么都不做", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    const epoch = c.snapshot().epoch;
    expect(c.seed(T0, 8)).toEqual([]);
    expect(c.seed(T0, 3)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 8, epoch });
  });

  it("起跳之后第一次 429 按系数减（32 → 24），而不是退回旧的 lastGood", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    c.waiters(T0, 1);
    roundTrip(c, K); // lastGood 8
    c.seed(T0, 32);
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 32, next: 24, reason: "rate_limited", lastBad: 32 },
    ]);
  });

  it("五分钟内有过任何 429（哪怕是旧 epoch 的）即不起跳；过了五分钟再起跳", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    const stale = c.admitted(T0);
    throttleNow(c); // 当前 epoch：8 → 6
    c.throttled(T0 + 1_000, stale, "rate_limited"); // 旧 epoch，同样算「刚被拒过」
    expect(c.snapshot().lastThrottledAt).toBe(T0 + 1_000);
    expect(c.seed(T0 + 2_000, 32)).toEqual([]);
    expect(c.snapshot().cap).toBe(6);
    // 一直有请求在飞，所以不会空闲重置；五分钟后证据过期，起跳放行。
    c.admitted(T0 + 1_000);
    const later = T0 + 1_000 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.seed(later, 32)).toEqual([{ key: KEY, previous: 6, next: 32, reason: "seeded" }]);
  });

  it("空闲重置清掉 lastThrottledAt", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    throttleNow(c);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later)).toHaveLength(1);
    expect(c.snapshot().lastThrottledAt).toBeUndefined();
  });
});
