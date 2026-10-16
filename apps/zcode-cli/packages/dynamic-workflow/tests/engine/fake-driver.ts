/**
 * fake driver：以脚本化裁决 + 手动兑现的 promise 驱动引擎核心，不用 timer / 时钟 / 会话 / 磁盘。
 * 测试同时扮演"沙箱"（调用引擎的 host API）与"模型"（调用引擎的 WorkflowReportSink）。
 */

import type {
  ActorSessionSeed,
  ArtifactPublishRequest,
  ArtifactVersionRecord,
  AskMessage,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorkflowDriver,
  ActorRef,
  WorldReadOp,
} from "../../src/engine/index.js";
import { refToString } from "../../src/engine/index.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排空微任务队列，让引擎内部的异步派发（惰性建会话）推进到位。 */
export async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface StartAskCall {
  session: SessionRef;
  instance: InstanceRef;
  message: AskMessage;
}

interface WorldReadCall {
  op: WorldReadOp;
  /** 位置实参数组（Boundary A 原样透传的脚本实参）。 */
  args: unknown[];
  deferred: Deferred<unknown>;
}

export interface FakeDriverOptions {
  /**
   * 为真时**不实现** `executeArtifactPublish`——模拟没有接产物存储的装配（纯 replay / 老
   * fake）。引擎应据此以 `ArtifactStoreUnavailable` 拒绝内容成员，而不是静默发布一个空产物。
   */
  withoutArtifactStore?: boolean;
  /** 为真时内容产物的发布返回受控 promise（由 test 兑现/拒绝）；默认立即解析。 */
  deferArtifactPublishes?: boolean;
  /** 为真时会话创建返回受控 promise（由 test 兑现）；默认立即解析。 */
  deferSessions?: boolean;
  /**
   * 模拟生产 driver 的档位解析：会话创建时把「实际解析出的模型」写进 actor 记录，
   * 正如 bootstrap 的 `journalActorResolvedModel` 所做（persona 只带档位，具体模型由宿主定）。
   * 装上它才能验证引擎侧的 putActor 不会把这个 driver 拥有的字段抹掉。
   */
  resolveModel?: (persona: PersonaSpec) => string;
  /** resolveModel 写库需要 runId（与引擎的 runId 一致）。 */
  runId?: string;
}

/** 从脚本给的 opts 里取 title（fake 只做真 driver 会做的这一小步）。 */
function titleOf(opts: unknown): string | undefined {
  const title = (opts as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : undefined;
}

export class FakeDriver implements WorkflowDriver {
  readonly startAsks: StartAskCall[] = [];
  readonly submitResponses: Array<{ instance: InstanceRef; verdict: SubmitVerdict }> = [];
  readonly cancels: InstanceRef[] = [];
  readonly sessionCreations: ActorRef[] = [];
  /** 每次会话创建收到的 persona（与 sessionCreations 同序）。 */
  readonly sessionPersonas: PersonaSpec[] = [];
  /**
   * 每次会话创建收到的种子（与 sessionCreations 同序，无种子记 undefined）。
   * 真 driver 会据它复制源会话的转录前缀；fake 只记录——引擎侧要验的是**传了什么**。
   */
  readonly sessionSeeds: Array<ActorSessionSeed | undefined> = [];
  readonly worldReads: WorldReadCall[] = [];
  /** 每次内容产物发布收到的请求（引擎侧要验的是**传了什么**：id / version / path / opts）。 */
  readonly artifactPublishes: ArtifactPublishRequest[] = [];
  /** deferArtifactPublishes 下的受控 promise，与 artifactPublishes 同序。 */
  readonly artifactDeferrals: Array<Deferred<ArtifactVersionRecord>> = [];
  /**
   * 内存中的「store」：`${id}@${version}` → 记录。真 driver 把字节拷进 tool-artifact store，
   * fake 只把记录留在这张表里——引擎不关心字节，它关心的是记录原样回到 journal。
   */
  readonly artifactStore = new Map<string, ArtifactVersionRecord>();
  readonly events: RunEvent[] = [];
  readonly sessionDeferrals: Array<Deferred<SessionRef>> = [];
  /** dispose 的调用次数（引擎契约：结算后恰好一次，晚于 run-settled）。 */
  disposeCalls = 0;
  /** dispose 被调用那一刻已发出的事件数（用于断言它晚于 run-settled）。 */
  eventsAtDispose: number | undefined;

  constructor(
    readonly journal: JournalStorePort,
    private readonly options: FakeDriverOptions = {},
  ) {
    // 「没有产物存储的装配」不是一个开关字段，而是**方法整个缺席**：引擎按方法在不在场
    // 分派，所以 fake 也必须在同一层表达它，否则测的就不是产品里的那条路。
    if (options.withoutArtifactStore === true) this.executeArtifactPublish = undefined;
  }

  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    this.sessionCreations.push(actor);
    this.sessionPersonas.push(persona);
    this.sessionSeeds.push(seed);
    if (this.options.resolveModel !== undefined) {
      // 生产接缝的等价物：读改写，绝不整条覆盖（persona / name 不是 driver 的字段）。
      const runId = this.options.runId ?? "run";
      const existing = this.journal.getActor(runId, actor.siteId, actor.ordinal);
      this.journal.putActor({
        ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
        resolvedModel: this.options.resolveModel(persona),
      });
    }
    const session: SessionRef = { id: `session:${refToString(actor)}` };
    if (this.options.deferSessions === true) {
      const d = defer<SessionRef>();
      this.sessionDeferrals.push(d);
      return d.promise;
    }
    return Promise.resolve(session);
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    this.startAsks.push({ session, instance, message });
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    this.submitResponses.push({ instance, verdict });
  }

  cancelAsk(instance: InstanceRef): void {
    this.cancels.push(instance);
  }

  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    const d = defer<unknown>();
    this.worldReads.push({ op, args, deferred: d });
    return d.promise;
  }

  /**
   * 内容产物的发布（Boundary B）。真 driver 在这里解析路径、读字节、写 store；fake 只按
   * 请求造一条记录并留在内存 map 里。**方法本身按选项缺席**——`withoutArtifactStore` 时
   * 整个属性是 undefined，这正是「装配没有 store」在类型层的样子。
   */
  executeArtifactPublish?: (request: ArtifactPublishRequest) => Promise<ArtifactVersionRecord> = (
    request,
  ) => {
    this.artifactPublishes.push(request);
    const record: ArtifactVersionRecord = {
      id: request.id,
      kind: request.op,
      version: request.version,
      contentType: request.op === "markdown" ? "text/markdown" : "application/pdf",
      bytes: (request.content ?? request.path ?? "").length,
      uri: `zcode-artifact://fake/${request.id}/${request.version}`,
      ...(request.path === undefined ? {} : { sourcePath: request.path }),
      ...(titleOf(request.opts) === undefined ? {} : { title: titleOf(request.opts) }),
      publishedAt: 1,
    };
    this.artifactStore.set(`${request.id}@${request.version}`, record);
    if (this.options.deferArtifactPublishes === true) {
      const d = defer<ArtifactVersionRecord>();
      this.artifactDeferrals.push(d);
      return d.promise;
    }
    return Promise.resolve(record);
  };

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  dispose(): void {
    this.disposeCalls++;
    this.eventsAtDispose ??= this.events.length;
  }

  // ——————————————————————————————— 断言辅助 ———————————————————————————————

  /** 已 startAsk 的实例 key 集合（用于断言 replay 命中未再执行）。 */
  startedInstanceKeys(): Set<string> {
    return new Set(this.startAsks.map((c) => refToString(c.instance)));
  }

  /** startAsk 的次数（可按实例过滤）。 */
  startAskCount(instance?: InstanceRef): number {
    if (instance === undefined) return this.startAsks.length;
    const key = refToString(instance);
    return this.startAsks.filter((c) => refToString(c.instance) === key).length;
  }

  /** 收集某类事件。 */
  eventsOfType<T extends RunEvent["type"]>(type: T): Array<Extract<RunEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<Extract<RunEvent, { type: T }>>;
  }

  /** node-settled 事件里 cached 命中的实例 key 顺序（用于 hold 规则断言）。 */
  cachedSettleOrder(): string[] {
    return this.events
      .filter((e): e is Extract<RunEvent, { type: "node-settled" }> => e.type === "node-settled" && e.cached === true)
      .map((e) => refToString(e.instance));
  }
}
