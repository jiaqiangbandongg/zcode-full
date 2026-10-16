// ============================================================
// AgentRuntime-backed WorkflowDriver：dispose 时的会话释放与静默账本
// ============================================================
// 两件事同住一个模块，因为它们是同一时刻的一体两面：dispose **不等**在飞的 turn，静默账正是
// 为这件事记的。释放的编排（{@link releaseActorSessions}）顺手把「此刻还有没有在写的 turn」
// 登记进账本，两者之间没有第二个观察点。
//
// 见 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」的
// 「What is imported」与「Tool contract and refusals」两行。
//
// 为什么需要这本账：修订一个**在飞**前驱时，amend 先 abort 它、再 await 它自己的结算 promise，
// 随后去数前驱会话的消息条数，把那个数当成「接续位置」（`inFlight.messageBoundary`）。但
// `dispose()` 是同步的——它对还有在飞 turn 的会话只挂了一条 `state.turn.then(close, close)`，
// 并不等；而引擎在 `cancelAsk` 中止 turn 之后立刻结算。于是「结算 promise 已解决」并不蕴含
// 「被中止的 turn 已经把它的尾巴写完」：那一刻数出来的条数可能少一条消息，或者数到一条 part
// 还没落全的消息。已完结前缀不受影响——它们的边界在 ask 结算时就已经 journal 了。
//
// 所以 driver 在 dispose 的那一刻把每个会话此刻仍在飞的 turn 记进这本账，amend 随后问一次
// 「哪些会话已经静默了」，只对静默的会话谈接续。
//
// **这不是用超时掩盖竞态**：到点仍未落地的会话不会被「当作静默继续用」，它只是拿不到
// `inFlight`——也就是本特性之前的行为（整段在飞转录丢弃，ask 从完整前缀重开）。我们宁可少做
// 一次优化，也绝不拿一个正在变动的条数去截断转录。
//
// ——————————————————————————————————————————————————————————————
// 这道闸门**关不住**的那一件事（2026-09-19 核实，已裁决接受）
// ——————————————————————————————————————————————————————————————
// core 的 turn 主线是全 await 的：中止时依次 await `abandon("cancelled")`
// （core/src/runtime/methods/turn-model-step.ts:365）、`persistCancelledStreamSnapshot`（同上 :372）
// 与 `persistAssistantMessage`（同上 :405），所以本闸门等到的「turn 落地」确实蕴含这几步写完。
//
// 漏在外面的是**流式工具的 part**，两条路，都与消息条数无关：
//   1. 同上 :633 的 `throwIfTurnAborted` 在跑 `abandon()` 的 try/catch **之外**（`drain()` 在 :646），
//      于是「流结束 → drain」这段窗口里到达的中止会绕过 abandon，把在飞的流式工具句柄丢在外面；
//   2. `abandon()` 自己只等 250ms（core/src/runtime/methods/streaming-tool-coordinator.ts:38、:121）。
// 两条都让一个已经落库的 assistant 消息在本闸门放行之后**再长出一个 part**
// （同上 :253 的 pending part、:294 的 running part）。等不到它：那些句柄与我们 await 的 promise
// 已经脱钩，没有东西可等——这不是闸门宽严的问题。
//
// 为什么可以接受：**数条数在 amend 时，抄消息在后继子代理首次派发时**
// （workflow-actor-transcript.ts 的 seedActorTranscript 按 `messageCount` 连 part 一起读）。
// 夹在中间落地的 part 会被原样抄走；真正丢的只有「抄的那一刻仍然缺席」的 part。两种形态都能
// 正常重水化（core/src/agent/session-history-hydrator.ts）：
//   - part 在场但停在 pending / running：hydrator 只给 `completed` 与 `error` 单独分支，其余一律
//     落到 :189 的 `INTERRUPTED_TOOL_RESULT`，所以 pending 与 running 走的是同一条路；
//   - part 整个缺席：assistant 的工具调用取自**在场的** part（同上 :173 的 `addAssistant`），
//     所以不会凭空出现一个没有结果的 `tool_use`；而一条既无正文、无 reasoning、无工具 part、
//     也无 token 基线的 assistant 消息会被整条跳过（同上 :162），也不会留下空消息。
// 两种形态都不会产出 provider 眼里非法的历史（不会有 tool_use 缺 tool_result，也不会有空
// assistant）。另外 part 的三态是**同一个 part id 上的 upsert**（adapters 的
// storage/session-store/repositories/messages.ts 的 `savePart`，`on conflict(id) do update`），
// 不是追加，所以迟到的 part 不会让消息条数变化，也就动不了任何边界。
//
// 第 1 条的正解在 core（把那句 `throwIfTurnAborted` 挪进 abandon 的保护区内），不在本文件。

import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import { defaultSchedule } from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * 等一个被中止的 turn 把尾巴写完的上界。
 *
 * 取值理由：它等的是**已经 abort 的** turn 走完 core 侧那几步已 await 的持久化
 * （abandon → 取消快照 → assistant 消息），是毫秒量级的收尾，不是一次模型请求。5 秒给足了
 * 慢磁盘与一次重试的余量，又不会让「修订一个在飞 run」这个交互明显变慢——而超了也只是
 * 少一次接续，不是失败。
 */
export const AMEND_TRANSCRIPT_QUIESCE_MS = 5_000;

/** 一个 run 的 actor 会话静默探询面。driver 私有能力，**不上** Boundary B 的 `WorkflowDriver`。 */
export interface ActorSessionQuiescence {
  /**
   * 此刻已经静默（不再有在写的 turn）的会话 id。有界等待，见 {@link AMEND_TRANSCRIPT_QUIESCE_MS}。
   *
   * 「不在集合里」有两种成因，调用方对两者同等处理（都不接续）：会话到点仍在写，或者这个
   * driver 压根不认识它——后者只会出现在「前驱这一世从没给该 actor 建过会话」的形状上，
   * 保守读成不静默即可（代价是少一次接续，而反过来是拿一个没人为其负责的条数去截断转录）。
   */
  quietSessions(): Promise<ReadonlySet<string>>;
}

/** driver 侧的写面：{@link ActorSessionQuiescence} 加一个 dispose 时的登记口。 */
export interface ActorSessionQuiescenceLedger extends ActorSessionQuiescence {
  /**
   * 登记一个会话与它**此刻**仍在飞的 turn 收尾链（`SessionState.turn`）。`pendingTurn` 缺席
   * 即该会话没有在飞 turn，立刻算静默。
   *
   * 由 `dispose()` 对它名下每个会话各调一次：那是唯一一个「还看得见全部会话、且已经没有新
   * turn 会被发起」的时刻（dispose 之后 `sessions` 就被清空了）。
   */
  noteDisposed(sessionId: string, pendingTurn: Promise<unknown> | undefined): void;
}

/**
 * 造一本会话静默账。纯内存、无 I/O；时钟可注入，所以测试不必真睡。
 *
 * 所有权：每个 driver 实例恰好一本，随 driver 一起生灭。刻意**不做**进程级注册表——一个会话
 * 属于哪个 run 已经由 driver 的归属关系说清了，第二张表只会带来「两边不一致时信谁」。
 */
export function createActorSessionQuiescence(options?: {
  clock?: WorkflowClock;
  /** 缺省 {@link AMEND_TRANSCRIPT_QUIESCE_MS}。 */
  quiesceMs?: number;
}): ActorSessionQuiescenceLedger {
  /** sessionId → dispose 那一刻仍在飞的 turn（`undefined` = 当时就没有在飞 turn）。 */
  const disposed = new Map<string, Promise<unknown> | undefined>();
  const schedule = options?.clock?.schedule ?? defaultSchedule;
  const quiesceMs = options?.quiesceMs ?? AMEND_TRANSCRIPT_QUIESCE_MS;

  return {
    noteDisposed(sessionId, pendingTurn) {
      disposed.set(sessionId, pendingTurn);
    },

    async quietSessions() {
      const quiet = new Set<string>();
      const waits: Promise<unknown>[] = [];
      for (const [sessionId, pending] of disposed) {
        if (pending === undefined) {
          quiet.add(sessionId);
          continue;
        }
        // turn 收尾链的成败与静默无关：无论 resolve 还是 reject，它都不会再写这个会话了。
        waits.push(
          pending.then(
            () => quiet.add(sessionId),
            () => quiet.add(sessionId),
          ),
        );
      }
      if (waits.length > 0) await settleWithin(Promise.all(waits), quiesceMs, schedule);
      // 快照一份再交出去：到点之后才落地的会话仍会往 `quiet` 里补写，而调用方读到的必须是
      // 「问的那一刻」的事实——一个会在背后自己变大的集合比一个保守的集合危险得多。
      return new Set(quiet);
    },
  };
}

/**
 * dispose 的每会话释放：退订活动观察、撤掉退避重驱、**登记静默**，再等在飞 turn 落地后关
 * actor runtime。
 *
 * 对每个 runtime 跑 app 关会话的**同一条**链——`closeBrowserSession` 内部依次 beginShutdown、
 * node_repl 会话释放、浏览器会话关闭；不另造一套子代理关闭链，那会漂移。关闭失败只 warn，
 * 结算不因它抛。
 *
 * 登记必须在 `state.turn.then(...)` **之前**：此刻 `state.turn` 就是要等的那条链，而 then 会把
 * 它换成另一个 promise。整个函数同步返回（关闭挂在 then 上），dispose 因此一如既往不阻塞。
 */
export function releaseActorSessions(
  deps: AgentRuntimeWorkflowDriverDeps,
  sessions: Iterable<SessionState>,
  ledger: ActorSessionQuiescenceLedger,
): void {
  for (const state of sessions) {
    state.modelActivity.unsubscribe();
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    ledger.noteDisposed(state.sessionId, state.turn);
    const close = (): void => closeActorRuntime(deps, state);
    if (state.turn === undefined) close();
    else state.turn.then(close, close);
  }
}

function closeActorRuntime(deps: AgentRuntimeWorkflowDriverDeps, state: SessionState): void {
  // Promise.resolve().then(...)：把同步抛出也归到同一条 warn 路径（最小 stub runtime 没有这个方法）。
  void Promise.resolve()
    .then(() => state.runtime.closeBrowserSession())
    .catch((error: unknown) => {
      deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.actor_runtime.close_failed",
        module: "bootstrap.app",
        sessionId: state.sessionId,
      });
    });
}

/** 等 `work` 落地，最多等 `delayMs`。到点即返回（不抛），闹钟在任一分支后都撤掉。 */
async function settleWithin(
  work: Promise<unknown>,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => {
    cancel = schedule(resolve, delayMs);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    // work 先落地时必须撤掉闹钟：一个还没响的 setTimeout 会把 CLI 的退出拖到上界。
    cancel?.();
  }
}
