/**
 * AutoDriver：集成测试用的**自治** fake driver——同时扮演 Boundary B 的 driver port 与"模型"。
 * 引擎核心的 fake-driver 套件（pure 包 tests/engine）里由 test 手动调 report sink；本包的集成测试
 * 需要一个能在 `startAsk` 到达时**自动**按脚本回报（stats + submit/turn-end/fail）的 driver，
 * 因为沙箱子进程是实时跑的，test 无法逐拍插手。
 *
 * 不用 timer / 时钟 / 会话 / 磁盘：回报经 queueMicrotask 异步推进（避免在引擎调用栈里同步重入）。
 * 与 pure 包的 FakeDriver 是同一模式的自治版，按房规不跨包 import 测试树——独立实现于此。
 */

import type {
  ActorRef,
  ArtifactPublishRequest,
  ArtifactVersionRecord,
  AskMessage,
  AskStats,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorkflowDriver,
  WorkflowError,
  WorkflowReportSink,
  WorldReadOp,
} from "@zcode/dynamic-workflow";
import { refToString } from "@zcode/dynamic-workflow";

/** 单次 ask 派发后，driver 代"模型"要做的一步动作。 */
export type AskAction =
  /**
   * `delayMs`：这一步不在微任务上、而是在真定时器之后才执行。给「谁先结算」承重的测试用：两个
   * 请求行可能落在子进程 stdout 的两个 chunk 里、被父进程在两个 tick 里准入，此时「多一个来回
   * 就晚结算」的微任务计数论证不再成立，只有真时间差能钉住次序（resume.test.ts）。
   */
  | { type: "submit"; payload: unknown; stats?: AskStats; delayMs?: number }
  | { type: "text"; finalText: string; stats?: AskStats }
  | { type: "fail"; error: WorkflowError }
  /** 确定性模型侧错误：driver 不结算节点，经 `stopRun` 让整个 run 停下（ProviderStop）。 */
  | { type: "stop-run"; error: WorkflowError };

/** 某 ask 站点的应答器：据实例/消息给出一步或一串动作（串用于 repair/nudge 序列）。 */
export type AskResponder = (ctx: { instance: InstanceRef; message: AskMessage }) => AskAction | AskAction[];

export interface AutoDriverConfig {
  /** 按 site id 的 ask 应答器。typed ask 必须给（否则默认提交 `{}`，多半校验失败）。 */
  asks?: Record<string, AskResponder>;
  /** world-read 处理器（args 为位置实参数组）；缺省对 glob 返回 []、对 read 返回 ""。 */
  worldReads?: (op: WorldReadOp, args: unknown[]) => unknown | Promise<unknown>;
  /**
   * 内容产物的发布处理器（用户面产物，docs/dynamic-workflow/authoring.md）。缺省回一条按请求
   * 回显的记录——真 driver 在这里读字节写 store，集成测试只关心请求形状与记录能不能原样
   * 回到 journal。抛错/拒绝即模拟 `ArtifactSourceMissing` 那一族的节点级拒绝。
   */
  artifacts?: (request: ArtifactPublishRequest) => ArtifactVersionRecord | Promise<ArtifactVersionRecord>;
  /** startAsk 钩子（resume 测试用它断言"零派发"或主动失败）。 */
  onStartAsk?: (instance: InstanceRef, message: AskMessage) => void;
}

interface StartAskCall {
  session: SessionRef;
  instance: InstanceRef;
  message: AskMessage;
}

export class AutoDriver implements WorkflowDriver {
  readonly events: RunEvent[] = [];
  readonly startAsks: StartAskCall[] = [];
  readonly sessionCreations: ActorRef[] = [];
  readonly cancels: InstanceRef[] = [];
  /** 每次内容产物发布收到的请求（断言线协议与引擎透传）。 */
  readonly artifactPublishes: ArtifactPublishRequest[] = [];

  private sink: WorkflowReportSink | undefined;
  private readonly scripts = new Map<string, { actions: AskAction[]; idx: number }>();

  constructor(
    readonly journal: JournalStorePort,
    private readonly config: AutoDriverConfig = {},
  ) {}

  /** harness 构造引擎后回填 sink（打破 driver↔engine 环依赖）。 */
  attach(sink: WorkflowReportSink): void {
    this.sink = sink;
  }

  createActorSession(actor: ActorRef, _persona: PersonaSpec): Promise<SessionRef> {
    this.sessionCreations.push(actor);
    return Promise.resolve({ id: `session:${refToString(actor)}` });
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    this.startAsks.push({ session, instance, message });
    this.config.onStartAsk?.(instance, message);
    const responder = this.config.asks?.[instance.siteId];
    const raw = responder ? responder({ instance, message }) : defaultAction(message);
    const actions = Array.isArray(raw) ? raw : [raw];
    this.scripts.set(refToString(instance), { actions, idx: 0 });
    this.perform(instance);
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    if (verdict.kind === "accept") return;
    // reject / nudge → 推进到下一步动作（脚本化 repair/nudge 序列）。
    const script = this.scripts.get(refToString(instance));
    if (script === undefined) return;
    script.idx++;
    this.perform(instance);
  }

  cancelAsk(instance: InstanceRef): void {
    this.cancels.push(instance);
  }

  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    const handler = this.config.worldReads ?? defaultWorldRead;
    return Promise.resolve(handler(op, args));
  }

  // async 而不是 `Promise.resolve(handler(...))`：处理器同步抛出时，后者会让异常从
  // executeArtifactPublish **同步**逃出去，落在 harness 的 readline 回调里变成一个没人接的
  // 异常，run 随之永远挂着。async 把同步抛出转成拒绝——真 driver 是 async 方法，天然如此。
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    this.artifactPublishes.push(request);
    const handler = this.config.artifacts ?? defaultArtifactPublish;
    return handler(request);
  }

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  private perform(instance: InstanceRef): void {
    const script = this.scripts.get(refToString(instance));
    if (script === undefined) return;
    const action = script.actions[script.idx];
    if (action === undefined) return; // 无更多动作：引擎会耗尽 repair/nudge 后自行结算失败。
    const delayMs = action.type === "submit" ? action.delayMs : undefined;
    const schedule = (fn: () => void): void => {
      if (delayMs === undefined) queueMicrotask(fn);
      else setTimeout(fn, delayMs);
    };
    schedule(() => {
      const sink = this.sink;
      if (sink === undefined) throw new Error("AutoDriver: sink 未 attach");
      if (action.type !== "fail" && action.type !== "stop-run" && action.stats !== undefined)
        sink.askStats(instance, action.stats);
      switch (action.type) {
        case "submit":
          sink.askSubmitAttempted(instance, action.payload);
          return;
        case "text":
          sink.askTurnEnded(instance, action.finalText);
          return;
        case "fail":
          sink.askFailed(instance, action.error);
          return;
        case "stop-run":
          sink.stopRun(action.error);
          return;
      }
    });
  }

  // ——————————————————————————————— 断言辅助 ———————————————————————————————

  startAskCount(): number {
    return this.startAsks.length;
  }

  eventsOfType<T extends RunEvent["type"]>(type: T): Array<Extract<RunEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<Extract<RunEvent, { type: T }>>;
  }
}

/** 无应答器时的兜底：untyped ask 回一句最终文本；typed ask 提交 `{}`（多半校验失败，仅兜底）。 */
function defaultAction(message: AskMessage): AskAction {
  return message.typed ? { type: "submit", payload: {} } : { type: "text", finalText: "ok" };
}

/** 缺省的产物发布：按请求回显一条记录（字节的家在 store，测试不关心它）。 */
function defaultArtifactPublish(request: ArtifactPublishRequest): ArtifactVersionRecord {
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    contentType: request.op === "markdown" ? "text/markdown" : "application/octet-stream",
    bytes: (request.content ?? request.path ?? "").length,
    uri: `zcode-artifact://auto/${request.id}/${request.version}`,
    ...(request.path === undefined ? {} : { sourcePath: request.path }),
    publishedAt: 1,
  };
}

/** 缺省 world-read：glob → []，read → ""。 */
function defaultWorldRead(op: WorldReadOp): unknown {
  return op === "glob" ? [] : "";
}
