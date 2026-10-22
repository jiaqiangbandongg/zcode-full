// ============================================================
// 「run 还欠着决定、主代理闲着」的提醒钟
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」。
//
// 升级问题与留白各自只发一条通知、唤起一轮。那一轮可能白跑：请求失败、应用退出、模型没作答就收尾、
// 或者一轮里带了几条而漏掉一条——这些在 run 那一侧都不留痕，而停驻的分支没有超时。所以这里不看
// 「通知送到了没有」，只看状态：**会话空闲着、且它在飞的某个 run 还开着决定**，到点就再告诉主代理一次。
//
// 三条纪律：
//   - 量的是**空闲时长**（命令队列排空起算，任何一轮开始即归零），不是决定开了多久——一轮在跑的时候，
//     原通知要么已经在模型眼前、要么排在这一轮后面，旁边再塞一条只是重复。
//   - 开着什么**到点现读**（宿主的 `readOpen`，即 run 快照的 pendingQuestions 与 waiting 的 holes）。
//     这里不留开集的副本，唯一记着的是每个 run 已经提醒过几次；开集事件只用来忘掉这个数。
//   - 每个 run 至多 {@link WORKFLOW_BLOCKED_REMINDER_DELAYS_MS} 那么多次，**入队即计数**：provider
//     一直失败时代价是两轮提醒然后安静，而不是一个重试环。
//
// 本文件是纯状态机：时钟、定时器、「谁在飞 / 开着什么 / 怎么发」全由宿主递进来
// （runtime 侧的宿主在 runtime/methods/dynamic-workflow-blocked-reminder.ts）。

import type { DynamicWorkflowRunHole, DynamicWorkflowRunPendingQuestion } from "@zcode/contracts";

const MINUTE_MS = 60_000;

/**
 * 两次提醒各自要求的空闲时长：第一次 15 分钟；第二次在第一次唤起的那一轮结束后再空闲 30 分钟。
 * 下标 = 该 run 已经提醒过的次数，越界即「不再提醒」。
 */
export const WORKFLOW_BLOCKED_REMINDER_DELAYS_MS: readonly [number, number] = [
  15 * MINUTE_MS,
  30 * MINUTE_MS,
];

/** 一个 run 此刻开着的决定。`holes` 只含 `waiting` 的。 */
export interface WorkflowOpenDecisions {
  questions: readonly DynamicWorkflowRunPendingQuestion[];
  holes: readonly DynamicWorkflowRunHole[];
  /** run 的草稿文件（快照的 `scriptPath`）；提醒文案据它告诉模型去哪读留白的上下文。 */
  draftPath?: string;
}

/** 一条该发的提醒。`ordinal` 从 1 起，`total` 是上限；`now` 是到点时刻（算等待时长用同一个钟）。 */
export interface WorkflowBlockedReminder {
  runId: string;
  open: WorkflowOpenDecisions;
  ordinal: number;
  total: number;
  now: number;
}

export interface WorkflowBlockedReminderHost {
  /** 本会话此刻在飞的 workflow run（每次求值现读，不缓存）。 */
  liveRunIds(): readonly string[];
  /** 会话此刻是否空闲（没有在跑的、排着的、预留的回合）。到点时的最后一道核对。 */
  isIdle(): boolean;
  /** 读这个 run 此刻开着的决定；没有开着的即 `undefined`。可以抛——钟跳过这个 run。 */
  readOpen(runId: string): Promise<WorkflowOpenDecisions | undefined>;
  /** 发出一条提醒。同步、不抛。 */
  remind(reminder: WorkflowBlockedReminder): void;
  /** 读快照失败的去处（缺席即静默）。 */
  onReadError?(runId: string, error: unknown): void;
  now?(): number;
  /** 排一个定时器，返回取消函数。缺省 `setTimeout`，且不拖住进程退出。 */
  setTimer?(callback: () => void, delayMs: number): () => void;
}

function defaultSetTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  // 一个 15 分钟的提醒钟不该是 headless 进程迟迟不退出的原因。
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class WorkflowBlockedReminderClock {
  /** 每个 run 已经提醒过的次数（0 即缺席）。这是本类唯一跨空闲段留存的状态。 */
  private readonly sent = new Map<string, number>();
  /** 当前空闲段的起点；`undefined` = 会话不在空闲段里（在跑一轮，或从没闲下来过）。 */
  private idleSince: number | undefined;
  private cancelTimer: (() => void) | undefined;
  /** 每次停钟 / 重排自增；到点回调与读快照的续体据它判断自己是否已经作废。 */
  private epoch = 0;
  private stopped = false;

  constructor(
    private readonly host: WorkflowBlockedReminderHost,
    private readonly delays: readonly number[] = WORKFLOW_BLOCKED_REMINDER_DELAYS_MS,
  ) {}

  /** 一轮开始（任何来源）：钟停，空闲时长作废。 */
  sessionBusy(): void {
    this.idleSince = undefined;
    this.disarm();
  }

  /**
   * 命令队列排空。已经在空闲段里时是 no-op：空排一次队列不是一轮，不能把空闲时长冲回零。
   */
  sessionIdle(): void {
    if (this.stopped || this.idleSince !== undefined) return;
    this.idleSince = this.now();
    this.arm(0);
  }

  /** 用户发来消息（prompt，或 steer 进在跑的一轮）：每个 run 重新得到一对提醒。 */
  userSpoke(): void {
    this.sent.clear();
  }

  /**
   * 这个 run 的开集变了（raised / resolved / reached / filled）：它重新得到一对提醒。会话正闲着
   * 的话空闲钟也从此刻重起——否则一个已经闲了三小时的会话上，新的一对会因为「早就过了 15 分钟」
   * 而永远排不上。
   */
  openSetChanged(runId: string): void {
    this.sent.delete(runId);
    if (this.stopped || this.idleSince === undefined) return;
    this.idleSince = this.now();
    this.arm(0);
  }

  /** 会话关闭：此后任何入口都不再排钟、不再发。 */
  stop(): void {
    this.stopped = true;
    this.idleSince = undefined;
    this.disarm();
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private disarm(): void {
    this.epoch += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 这个 run 下一次提醒要求的空闲时长；次数用完即 `undefined`。 */
  private delayFor(runId: string): number | undefined {
    return this.delays[this.sent.get(runId) ?? 0];
  }

  /**
   * 此刻在飞的 run；顺手忘掉不再在飞的 run 的次数——同一个 id 之后被 resume 重臂是新的一世，
   * 从第 1 次算起。
   */
  private liveRuns(): readonly string[] {
    const live = this.host.liveRunIds();
    if (this.sent.size > 0) {
      const alive = new Set(live);
      for (const runId of [...this.sent.keys()]) {
        if (!alive.has(runId)) this.sent.delete(runId);
      }
    }
    return live;
  }

  /** 排下一个到点：在飞的 run 里、大于 `reached` 的最小延迟。没有就什么也不排。 */
  private arm(reached: number): void {
    this.disarm();
    if (this.idleSince === undefined) return;
    let next: number | undefined;
    for (const runId of this.liveRuns()) {
      const delay = this.delayFor(runId);
      if (delay === undefined || delay <= reached) continue;
      if (next === undefined || delay < next) next = delay;
    }
    if (next === undefined) return;
    const epoch = this.epoch;
    const target = next;
    const wait = Math.max(0, this.idleSince + target - this.now());
    const setTimer = this.host.setTimer ?? defaultSetTimer;
    this.cancelTimer = setTimer(() => {
      void this.expire(epoch, target);
    }, wait);
  }

  /** 空闲时长到了 `reached`：现读每个到期 run 的开集，仍开着的各发一条。 */
  private async expire(epoch: number, reached: number): Promise<void> {
    if (epoch !== this.epoch || this.stopped) return;
    this.cancelTimer = undefined;
    // 最后一道核对：钟应当已经被那一轮的开始停掉，这里只防接线漏了一处。
    if (!this.host.isIdle()) return;

    const due: { runId: string; open: WorkflowOpenDecisions }[] = [];
    for (const runId of this.liveRuns()) {
      const delay = this.delayFor(runId);
      if (delay === undefined || delay > reached) continue;
      try {
        const open = await this.host.readOpen(runId);
        if (open !== undefined && open.questions.length + open.holes.length > 0) {
          due.push({ runId, open });
        }
      } catch (error) {
        this.host.onReadError?.(runId, error);
      }
    }
    // 读快照期间来了一轮（或会话关了）：这次到点作废。那一轮要么自己带着通知，要么结束后重新起钟。
    if (epoch !== this.epoch) return;

    const now = this.now();
    for (const { runId, open } of due) {
      const ordinal = (this.sent.get(runId) ?? 0) + 1;
      // 入队即计数，先记后发：`remind` 会同步唤起一轮并经 sessionBusy 停钟。
      this.sent.set(runId, ordinal);
      this.host.remind({ runId, open, ordinal, total: this.delays.length, now });
    }
    // 没有一轮因此开始（没有到期且仍开着的，或通知被入口丢了）：排更晚的那个延迟，若有。
    if (epoch === this.epoch) this.arm(reached);
  }
}
