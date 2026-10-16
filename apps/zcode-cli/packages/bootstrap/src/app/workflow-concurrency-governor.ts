// ============================================================
// Workflow 并发治理器（进程级，按 provider key 分桶，**每个模型请求**准入）
// ============================================================
// 一个 CLI 进程里所有 run 加主代理
// 共用一个 provider 配额，所以治理器是**进程级**的：每个 `${providerId}/${modelId}` 一个桶，
// 桶里一台纯 AIMD 状态机（`ConcurrencyController`，@zcode/dynamic-workflow）+ 一条按 run 轮转的
// 准入队列。
//
// 闸门粒度是**模型请求的每一次尝试**：runner 每次尝试前 `acquire`、尝试结束 `release`，
// 退避 sleep 期间不持槽。ticket 就是该次尝试的状态事件汇：runner 把该尝试的
// `ModelNetworkStatus` 事件同时投递给 ticket，治理器从 ticket 上读结果。本方案
// **不**再用 adapter 级 `addStatusSink`——同一事件不能既经 ticket 又经 adapter sink 各喂一次。
//
// 这里是治理器里**唯一**会碰时钟与定时器的地方：控制器只收 `now`；冷却到期要唤醒等待者，
// 所以需要一个 setTimeout（可注入，unref）。

import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR,
} from "./workflow-default-concurrency.js";

/** provider key：最具体的配额键。 */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * driver 看到的窄端口（不是整个治理器）。
 *
 * - `tryAdmit`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `admit` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `admit`：排队（run 间轮转）直到 `inFlight < cap` 且不在 Retry-After 冷却；`signal` 被 abort 即
 *   出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。扇出只到**此刻在该 key 上有在飞或排队请求**的
 *   run（决策 8）。
 * - `setRunBound` / `clearRunBound`：本 run 自己的并发上界（launch 时登记、每次 retune 覆盖、launch
 *   结算时清掉）。它抬的是这个 run **用过的** key 的增长上限：`max(2D, 这些 run 的最大上界)`
 *   （docs/dynamic-workflow/concurrency.md「The governor」）——用户把一个 run 调到 40，桶的 cap 才
 *   爬得到 40，否则 40 个子代理会有一大半停在「等待槽位」。
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * 主代理用的 admission：acquire 立即放行——不排队、不看冷却——但**计入 inFlight**
   * 且喂信号（它的请求 provider 同样看得见）。主代理的 turn 永不被 workflow 流量阻塞。
   */
  observer(): ModelRequestAdmission;
  /** 控制器只读快照；没有这个 key 的桶时为 undefined。 */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** 默认并发 D：桶创建时的初值与空闲重置的落点；自动增长到 `2 × D`。进程启动时算一次。 */
  defaultConcurrency: number;
  /** 时钟（可注入）。 */
  now?: () => number;
  /** 定时器（可注入）：冷却到期唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 限流类 retry 原因 → 控制器的 throttled 信号。 */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** 不是 provider 失败的 retry 原因：既不减 cap 也不清 streak——只当尝试终结。 */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** 每个 run 在飞（已准入未结算）的请求数（扇出的依据：有在飞或排队请求的 run 才收 cap 变化）。 */
  readonly inFlightByRun: Map<string, number>;
  /** 等待者按 run 分队列（run 间轮转，大 fan-out 不能饿死后来的小 run）。 */
  readonly queues: Map<string, Waiter[]>;
  /** 轮转游标：上一次放行的 run，下一次从它之后开始找。 */
  lastGrantedRun?: string;
  /**
   * 在这个 key 上请求过准入的 run（observer 除外）。增长上限只看它们登记的上界：一个跑在别的
   * 模型上的大 run 不该抬这个 key。run 清掉上界时一并移出。
   */
  readonly runs: Set<string>;
  cancelCooldownWake?: () => void;
}

/** observer（主代理）的 run 身份：不排队、不订阅，只在扇出过滤里作为「不是任何 run」出现。 */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等冷却的定时器把进程钉住：run 结束、进程要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** run 级订阅（不按 key）：扇出时按桶的 engaged 集合过滤。 */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();
  const baseGrowthLimit = WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR * options.defaultConcurrency;
  /** 在飞 run 登记的自有上界（setRunBound / clearRunBound）。 */
  const runBounds = new Map<string, number>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // 惰性建桶，初值 = 默认并发；此后 run 来来去去都不重置它（只有空闲 5 分钟会，决策 19/20）。
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.defaultConcurrency, baseGrowthLimit),
        inFlightByRun: new Map(),
        queues: new Map(),
        runs: new Set(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /**
   * 扇出：只给此刻在该 key 上有在飞或排队请求的 run（决策 8）；`alsoTo` 另加一批收件人（上界引起的
   * 变化要到在这个 key 上登记着的 run，见 refreshGrowthLimit）。
   */
  const fanOut = (
    bucket: Bucket,
    changes: ConcurrencyChange[],
    alsoTo?: ReadonlySet<string>,
  ): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 ||
        (bucket.queues.get(runId)?.length ?? 0) > 0 ||
        alsoTo?.has(runId) === true;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  /**
   * 重算一个桶的增长上限：`max(2D, 用过它的 run 里登记过的最大上界)`，并在同一刻试着**起跳**到那个
   * 最大上界（docs/dynamic-workflow/concurrency.md「Seeding」）：用户把 run 调到 32，cap 就当场是
   * 32，而不是每四次成功爬一级。压低到 cap 之下时控制器当场拉低 cap（`limit_lowered`）；起跳在五分钟
   * 内被拒过时由控制器拒绝（`seeded` 不发），cap 照常爬。
   *
   * 这两种变化的起因是某个 run 的上界，而不是某个请求，所以扇出除了此刻 engaged 的 run，还要到
   * 每个在这个 key 上登记着的 run——retune 的那一刻，调高的那个 run 很可能一个请求都不在飞。
   */
  const refreshGrowthLimit = (bucket: Bucket): void => {
    let largestBound: number | undefined;
    for (const runId of bucket.runs) {
      const bound = runBounds.get(runId);
      if (bound !== undefined && (largestBound === undefined || bound > largestBound)) {
        largestBound = bound;
      }
    }
    const limit = Math.max(baseGrowthLimit, largestBound ?? 0);
    const changes =
      limit === bucket.controller.snapshot().growthLimit
        ? []
        : bucket.controller.setGrowthLimit(now(), limit);
    if (largestBound !== undefined) changes.push(...bucket.controller.seed(now(), largestBound));
    fanOut(bucket, changes, bucket.runs);
  };

  /** 一个 run 第一次在这个 key 上请求准入：记下它，它登记过的上界从此算进这个桶。 */
  const noteRunUsed = (bucket: Bucket, runId: string): void => {
    if (bucket.runs.has(runId)) return;
    bucket.runs.add(runId);
    if (runBounds.has(runId)) refreshGrowthLimit(bucket);
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * 一次已准入尝试的 ticket：事件映射保持一致。任一终结映射后结算（幂等）；`release()`
   * 未见终结事件即按 `ended` 处理。结算后的 publish / release 一律惰性——runner 在极少数路径上
   * （尝试已结束后的兜底事件）可能仍会投递。
   */
  const mintTicket = (bucket: Bucket, runId: string, epoch: number): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // 先扇出再减在飞：产生这条变化的请求正是本 run 的，它此刻仍算 engaged——否则一个 run 唯一的
      // 在飞请求撞出的减半，会因为「已经不在飞」而漏发给它自己。
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // 结算释放了一个名额（或改了 cap），排队者可能可以放行。
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // 准入时已计入 inFlight，这里没有新信息。
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // retryable:true 的 failed 紧随一条 retry_scheduled——那条才是信号。
            if (event.retryable) return;
            // 不可重试的限流：
            // 主对话 / 工具侧撞上 3008 这类被分类器判终止的 429，仍是一次字面意义上的并发信号——
            // 只当「链结束」会让 cap 从未因它降过。配额码也走这一支：多减一次半，run 随即停下，无害。
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** 放行一个请求：`observe` 在前（准入也是一次「信号」），再 `admitted` 拿 epoch。 */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** 按轮转挑下一个有等待者的 run。 */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter((runId) => (bucket.queues.get(runId)?.length ?? 0) > 0);
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** 放行尽可能多的等待者（闸门：inFlight < cap 且不在冷却），喂 waiters，必要时定冷却闹钟。 */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) => {
    const bucket = bucketFor(key);
    noteRunUsed(bucket, runId);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    noteRunUsed(bucket, runId);
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  const setRunBound: WorkflowConcurrencyPort["setRunBound"] = (runId, bound) => {
    runBounds.set(runId, bound);
    for (const bucket of buckets.values()) {
      if (bucket.runs.has(runId)) refreshGrowthLimit(bucket);
    }
  };

  const clearRunBound: WorkflowConcurrencyPort["clearRunBound"] = (runId) => {
    runBounds.delete(runId);
    for (const bucket of buckets.values()) {
      if (bucket.runs.delete(runId)) refreshGrowthLimit(bucket);
    }
  };

  // 不排队、不看冷却（决策 37/47）；observe 在 grant 里。快路径总命中，所以 runner 永远不会为主代理
  // 的请求发 queued / admitted（决策 44）。
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    setRunBound,
    clearRunBound,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * 进程级单例（决策 5）：默认并发在首次取用时算一次；此后每个 app（会话）的主 runtime 挂它的
 * observer，run service 拿同一个端口给 driver。
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    defaultConcurrency: resolveWorkflowDefaultConcurrency(),
  });
  return processGovernor;
}
