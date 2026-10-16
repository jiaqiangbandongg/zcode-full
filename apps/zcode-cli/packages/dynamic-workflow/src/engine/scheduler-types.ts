/**
 * scheduler.ts 顶到 oxlint max-lines 上限（400 行），把调度器的内部类型（Deferred /
 * AskNode / Actor）与引擎注入的依赖面 SchedulerHost 拆到本文件；公开面仍从 scheduler.ts 导出
 * （SchedulerHost 在那里原地再导出，engine.ts 的导入路径不变）。
 *
 * 单独成文件的理由不只是行数：scheduler-submit.ts 里的自由函数也要拿到 AskNode / SchedulerHost，
 * 从这里导入，两侧都不必反向 import 调度器本体。
 */

import type { ImportedActorState } from "./imported-cache.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  Caps,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  ValidateFn,
  WorkflowDriver,
  WorkflowError,
} from "./types.js";

/** 一个可外部结算的 promise。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 引擎注入给调度器的依赖面。 */
export interface SchedulerHost {
  readonly runId: string;
  /**
   * 本 run 的并发上界。**每次派发前现读**，不是构造时抄下的一份：`setMaxConcurrency` 会整份
   * 换掉引擎持有的 caps（docs/dynamic-workflow/concurrency.md「Two bounds on a run」），
   * 而调度器的派发判据必须看见新值。引擎侧因此以 getter 实现这个属性。
   */
  readonly caps: Caps;
  readonly driver: WorkflowDriver;
  readonly validate: ValidateFn;
  /** 分配某站点的下一个执行序号（与 world-read/actor 共用一套计数器）。 */
  nextOrdinal(siteId: string): number;
  /**
   * 受 replay 结算次序约束地释放一次命中（docs/execution-engine.md「Replaying the settle order」）。
   * 非 resume、或次序表里没有这个实例时立即执行 `release`。
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;
  /** 事件既落 journal 又扇出（Boundary C）。 */
  record(event: RunEvent): void;
  isRunSettled(): boolean;
  /** run 已结算时用于 reject 的错误。 */
  runError(): WorkflowError;
  /** run 级失败。 */
  failRun(error: WorkflowError): void;
  /**
   * 导入缓存是否已关闭（amend-resume）。关门由引擎自己做
   * （driver 上报 askMutating、或 live 的 world-run），调度器只读这个位——一个 ask 转 live 本身
   * **不**关门：它还什么都没改。
   */
  importCacheClosed(): boolean;
  /** 该记录行在崩溃前是否 live 跑过（resume 时引擎从事件恢复；非 resume 恒 false）。 */
  wasLiveBeforeResume(instance: InstanceRef): boolean;
  /**
   * 该记录行的准入是否发生在导入缓存关闭**之前**（按事件次序恢复，见 engine-world.ts 的
   * recoverImportClosure）。续跑前驱在飞 ask 的判定要它才能在 resume 时精确复原；非 resume 恒 false。
   */
  wasQueuedBeforeImportClose(instance: InstanceRef): boolean;
}

/** 一个 live（需真正派发执行）的 ask 节点。 */
export interface AskNode {
  instance: InstanceRef;
  actor: Actor;
  actorSeq: number;
  instructions: string;
  hash: string;
  spec: AskSpec;
  deferred: Deferred<unknown>;
  repairsRemaining: number;
  nudgesRemaining: number;
  settled: boolean;
  dispatched: boolean;
  lastStats?: AskStats;
  /**
   * 准入时算好的指令开头（{@link AskNode.instructions} 的前 N 字符）。存在节点上而不是两处
   * 各算一次：`node-queued` 与 `node-dispatched` 必须带**同一个**串（派发重复出生事实，
   * 见 types.ts 的 `node-dispatched`），存下来这件事就由构造保证，不靠两处调用保持同步。
   */
  instructionsHead?: string;
}

/** 调度器维护的 actor 运行态。 */
export interface Actor {
  ref: ActorRef;
  id: ActorId;
  persona: PersonaSpec;
  name?: string;
  /** journal 中该 actor 已记录的 ask 节点数——replay 时 live 节点须等其全部准入后才放行。 */
  recordedCount: number;
  /** 下一个待准入的 actorSeq。 */
  nextAdmitSeq: number;
  /** 已到达但未准入的记录节点释放动作，按 actorSeq 挂起（hold 规则）。 */
  pendingRecorded: Map<number, () => void>;
  /** 已到达但在等记录节点排空的 live 节点释放动作，按到达顺序。 */
  pendingLive: Array<() => void>;
  /** 已准入待派发的 live 节点（FIFO = 准入顺序）。 */
  liveQueue: AskNode[];
  /** 正在执行的 live 节点（actor 串行，至多一个）。 */
  current?: AskNode;
  /** 会话惰性创建，缓存其 promise（每 actor 一次）。 */
  sessionPromise?: Promise<SessionRef>;
  session?: SessionRef;
  /**
   * amend-resume 的导入消费态（引擎在 createActor 里按名 + persona 匹配后挂上，见
   * imported-cache.ts 的 `matchImportedActor`）。缺席即该 actor 全新重跑。
   */
  imported?: ImportedActorState;
}
