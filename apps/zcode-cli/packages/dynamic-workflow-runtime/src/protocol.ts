/**
 * NDJSON 线协议（Boundary A 的传输编码）。
 *
 * 沙箱子进程与父进程 harness 之间通过 stdio 上的换行分隔 JSON 通信。本模块是**唯一真源**，
 * 描述每种消息的种类与字段；子进程源码（child-source.ts 的内嵌字符串）里以纯手写方式镜像这些
 * 形状——它无法 import 本模块（经 `toString()` 内嵌进入口文件运行），故两处必须一起改。父进程侧则直接
 * import 这些类型，保证桥接代码有严格类型。
 *
 * 方向约定：
 *   child → parent：create-actor（即发即忘）/ request（ask/world-read/publish-artifact/hole，需应答）/
 *                   event（log、report、declare-artifact）/ complete
 *   parent → child：response（应答 request，并搭载最新预算快照）
 *
 * 为何 create-actor 不走 request/response：Boundary A 要求 `createActor` **同步**返回句柄。子进程无法为同步返回等待一次 round-trip，故它同步造一个
 * child-local 句柄（`local#N`）并即发即忘一条 create-actor，父进程据 stdio 的 FIFO 顺序在处理
 * 任何引用该句柄的 ask 之前完成 local→engine ActorId 的映射（父进程的 create-actor 处理是纯同步的）。
 */

import type { ArtifactContentOp, ArtifactPresetOp, WorldReadOp } from "@zcode/dynamic-workflow";

// ————————————————————————————————————————————————————————————————
// 结构化错误的线形态
// ————————————————————————————————————————————————————————————————

/**
 * 跨边界的错误形态。ask 的拒绝（WorkflowError）以此过界，子进程据此在沙箱内重建一个带
 * `code`/`violations`/`finalText` 的 Error，使脚本的 try/catch 能按结构处理。
 * 模型侧错误不再过界：它们要么在 runtime 内重试，
 * 要么让整个 run 停下，脚本永远看不到。
 */
export interface WireError {
  name: string;
  message: string;
  code?: string;
  violations?: unknown[];
  finalText?: string;
  stack?: string;
}

// ————————————————————————————————————————————————————————————————
// child → parent
// ————————————————————————————————————————————————————————————————

/** 同步创建 actor：即发即忘，父进程据 FIFO 在后续 ask 之前建立 local→ActorId 映射。 */
export interface CreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

/**
 * 需应答的 host 调用：ask、world-read，或**内容产物的发布**。
 *
 * 产物的两族在这里分道：内容成员（`file`/`markdown`）是
 * 效应，脚本 await 它、要能 catch 它的拒绝，所以走 request/response；预置成员是声明，返回
 * void，走下面的事件通道。
 */
export interface RequestMessage {
  kind: "request";
  id: string;
  /**
   * `hole`：脚本到达一处未补全的留白（docs/execution-engine.md「Holes」）。父进程经引擎把它停下，
   * 直到主代理补全，再以 `{code}` 应答；停驻的分支是一条在飞请求，兄弟分支照跑、停滞检测不响。
   */
  type: "ask" | "world-read" | "publish-artifact" | "hole";
  siteId: string;
  /** ask 专属：child-local actor 句柄。 */
  actor?: string;
  /** ask 专属：指令正文。 */
  instructions?: string;
  /** hole 专属：留白的字面名。 */
  name?: string;
  /** hole 专属：给主代理的提示（引擎记录前截到 4000 字符）。缺席即作者没写。 */
  prompt?: string;
  /** world-read 专属：op（词汇表由 world-read 注册表推导，加原语不改本文件）。 */
  op?: WorldReadOp;
  /**
   * publish-artifact 专属：内容成员的 op。**刻意与 `op` 分成两个字段**而不是把 `op` 加宽成
   * 两个词汇表的联合：加宽之后父进程分派时拿到的就是一个必须再窄化一次的值，而窄化的依据
   * 只有 `type`——那正好是两个字段各自表达的东西。两张注册表、两个字段，谁也不必猜。
   */
  artifactOp?: ArtifactContentOp;
  /**
   * world-read 专属：**位置实参数组**。lowering 原样打包脚本调用点的实参，本层原样透传，
   * 元数与校验都归 driver。
   * 单实参的 `arg?: string` 撑不住多参/无参的 op（`files.grep(pattern, glob?)`、`git.status()`）。
   */
  args?: unknown[];
}

/**
 * 即发即忘的事件，按 `type` 判别。三种都不需要应答，但**耐久性不同**：`log` 丢了只是丢一行
 * 闲话，`report` 丢了是丢一条发现（父进程会把它落 journal），所以事件通道的 FIFO 顺序对
 * report 是承重的——父进程 journal 的就是到达的东西。
 *
 * `declare-artifact` 与 report 同在这条通道上，而且**必须**如此：一条打了标签的 report 只有在
 * 它的预置声明已经到达父进程之后才合法（否则引擎以 `ArtifactUndeclared` 失败整个 run）。
 * 脚本里声明在前、report 在后，而同一条 FIFO 保证父进程也按这个顺序看到它们。把声明改成
 * 需应答的 request 并不能改善这一点，只会让一个同步返回 void 的 facade 成员凭空多出一次等待。
 */
export type EventMessage =
  | LogEventMessage
  | ReportEventMessage
  | DeclareArtifactEventMessage
  | PhaseEnteredEventMessage;

/**
 * 控制流经过了一个 `phase("…")` 标记。走事件通道：脚本从不 await 它；无站点、不落 journal，父进程只让引擎发一条
 * `phase-entered`。到达顺序照样承重——「先进 B 再派发 B 里的 ask」是时间线点灯的依据。
 */
export interface PhaseEnteredEventMessage {
  kind: "event";
  type: "phase-entered";
  /** 作者的原词，lowering 已去两端空白。 */
  name: string;
}

/** 进度消息：无站点、不落 journal。 */
export interface LogEventMessage {
  kind: "event";
  type: "log";
  message: string;
}

/**
 * 一条中间结果。走事件通道而不是 request/response，因为脚本从不 await 它；但与 `log` 不同，
 * 父进程会按 `siteId` × ordinal 把它落成一行 `dwf_node`。
 */
export interface ReportEventMessage {
  kind: "event";
  type: "report";
  siteId: string;
  item: unknown;
  /**
   * 产物标签（`report(item, "perf")`）：这条 item 同时喂给哪个预置产物。缺席即无标签
   * （JSON.stringify 会把 undefined 整个键丢掉，所以线上就是"没有这个键"）。
   */
  artifactId?: string;
}

/**
 * 一次**预置产物的声明**（`artifact.chart` 等）。走事件通道而不是 request/response，因为
 * facade 成员同步返回 void——脚本从不 await 它。父进程按 `siteId` × ordinal 落一行
 * `dwf_node`（幂等重复声明除外），所以本条消息的到达顺序同样是承重的（见 {@link EventMessage}）。
 */
export interface DeclareArtifactEventMessage {
  kind: "event";
  type: "declare-artifact";
  siteId: string;
  op: ArtifactPresetOp;
  /** 位置实参数组（`[id, spec]`），lowering 原样打包、本层原样透传。 */
  args: unknown[];
}

/** 脚本执行终结：顶层 artifact 或抛错。 */
export interface CompleteMessage {
  kind: "complete";
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** child → parent 的全部消息。 */
export type ChildMessage = CreateActorMessage | RequestMessage | EventMessage | CompleteMessage;

// ————————————————————————————————————————————————————————————————
// parent → child
// ————————————————————————————————————————————————————————————————

/** 对一次 request 的应答。 */
export interface ResponseMessage {
  kind: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** parent → child 的全部消息。 */
export type ParentMessage = ResponseMessage;

/**
 * 子进程的初始 payload。作为 JSON 字面量内嵌在入口文件里（child-source.ts 的 `renderChildEntry`），
 * 不再经 argv / base64：Windows 命令行上限 32,767 字符。
 */
export interface ChildPayload {
  /** lowered 脚本的 async 函数体（自由标识符仅 `__host`）。 */
  lowered: string;
  /**
   * 本次 run 的实参，注入沙箱成为**冻结**的 `args` 全局（lowering 把脚本里的 `args` 读
   * 改写成 `__host.args`）。
   *
   * 只在 spawn 时过界一次，此后不再更新——实参在 run 的整个生命周期里是常量。缺席解读为
   * `{}`：内联 run 与老 journal
   * 行都走这条路，脚本里的 `args.x` 因此永远是一次合法的属性读而不是一次崩溃。
   */
  args?: Record<string, unknown>;
  /**
   * 堆上限（MB）。**只在 argsPrefix（SEA 自 re-exec）路径生效**：那条路上传不了
   * `--max-old-space-size`，入口文件在 `execArgv` 里看不到旗标时自己 `v8.setFlagsFromString`
   * best-effort。缺省路径由真正的 Node 旗标生效，入口文件看到旗标就跳过本字段。
   * 效果不保证（V8 对已在启动期消费的旗标可能不再理会），记为 SEA 限制。
   */
  maxOldSpaceSizeMb?: number;
}
