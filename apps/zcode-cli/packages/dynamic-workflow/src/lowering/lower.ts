import ts from "typescript";
import {
  collectDiagnostics,
  createWorkflowProgram,
  WORKFLOW_FUNCTION_NAME,
  type CompileDiagnostic,
  type WorkflowProgram,
} from "../compiler/compile.js";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import { isArtifactPresetOp, type ArtifactOp, type WorldReadOp } from "../facade/registry.js";
import { collectFacadeMisuse } from "../analysis/facade-misuse.js";
import {
  collectSites,
  isFacadeDeclared,
  resolveSymbol,
  type HoleSite,
  type SiteTable,
} from "../analysis/sites.js";
import { collectHoleDiagnostics } from "../analysis/hole-sites.js";
import { lowerHoleCall, printHoleBodies, TRANSPILE_OPTIONS } from "./lower-hole.js";

/**
 * Lowering（instrumentation emit step）：把已 typecheck + analyze 干净的 workflow 脚本降级为沙箱可跑的
 * **JavaScript**。两件事：
 *
 *   1. 剥离类型——程序已经 typecheck 过，这里是对同一份源码做 transpile 级别的类型擦除。
 *   2. 用站点表里的**静态 site id** 给每个 facade 调用打桩，改写成 Boundary A 的 `__host.*`：
 *        agent(name, persona)        -> __host.createActor("actor#2", name, persona)
 *        planner.ask<Plan>(text)     -> __host.ask("ask#3", planner, text)
 *        maybe?.ask<Plan>(text)      -> maybe === null || maybe === undefined
 *                                         ? undefined : __host.ask("ask#3", maybe, text)
 *                                       （可选链的短路保留：receiver 为 nullish 时跳过 ask、
 *                                        实参不求值；非标识符 receiver 经临时变量求值一次）
 *        files.glob(p) / files.read(p)
 *                                    -> __host.worldRead("world-read#1", "glob", [p])
 *                                       __host.worldRead("world-read#2", "read", [p])
 *        report(x)                   -> __host.report("report#1", x)
 *        report(x, "perf")           -> __host.report("report#1", x, "perf")
 *        artifact.file(id, p, o)     -> __host.publishArtifact("artifact#1", "file", [id, p, o])
 *        artifact.chart(id, spec)    -> __host.declareArtifact("artifact#2", "chart", [id, spec])
 *        log(msg)                    -> __host.log(msg)
 *        phase("gate")               -> __host.enterPhase("gate")（无站点；引擎只发一条事件）
 *        model("GLM-5.3-Flash")      -> "GLM-5.3-Flash"（无站点、无 host 调用：ModelRef 运行期即名字）
 *        channel<T>("facts")         -> __host.channel("facts")（无站点；队列在 cell 内构造）
 *        future(async () => {...})   -> __host.future(async () => {...})（无站点；cell 立即调用）
 *        hole<T>(n, p?, body?)       -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src), body?)
 *                                       （lower-hole.ts；已补全的函数体另以文本形式进 holeBodies）
 *      Join（Promise.all）与 fan-out 是沙箱内的普通 promise 机制，不是 host 调用，原样保留。
 *
 * ————————————————————————————————————————————————————————————————
 * 输出契约（harness 契约，沙箱负责 wrap）：
 * ————————————————————————————————————————————————————————————————
 * {@link LoweredWorkflow.code} 是 lowered 脚本的 **async 函数体**：顶层 `await` 与末尾
 * `return <artifact>` 都合法，因为 harness 会把它包进一个 async 函数里执行，形如
 *
 *     const __run = async (__host) => { <code> };
 *
 * 也就是说 code 里唯一的自由标识符是 `__host`（见 {@link HOST_BINDING}）——facade 的
 * `agent` / `log` / `files` / `phase` 都已改写掉，沙箱 vm 的 globals
 * 只需提供 ES intrinsics 加一个 `__host` 即可。
 * schema 从不跨沙箱边界：引擎按 site id 从编译产物里查 schema，code 里不含任何 schema。
 *
 * {@link LoweredWorkflow.siteIds} 是被打桩的全部 facade site id，按源码顺序排列（asks /
 * actors / world-reads / reports / artifacts；`log`/`phase` 不占 site id，故不在其中）——供
 * harness 与测试断言"每个 site id 恰好出现一次"。
 *
 * 确定性：printer + transpile 都是纯函数，同一份输入 → 逐字节相同的输出。
 */

/** harness 必须为 lowered code 绑定的自由标识符（Boundary A 的 host 句柄）。 */
export const HOST_BINDING = "__host";

/**
 * 无站点、按名字原样透传到 `__host.<name>(...)` 的顶层 facade 函数：`log`（进度叙事）、
 * `channel` / `future`（沙箱内的流水线原语，docs/dynamic-workflow/authoring.md「Streams」）。
 * 它们都没有 journal 键，所以不进站点表；身份仍按 checker 解析到 facade 声明判定。
 */
const HOST_PASSTHROUGH_FUNCTIONS: ReadonlySet<string> = new Set(["log", "channel", "future"]);

/** lowering 的产物：sandbox 输入的 JS 体 + 打桩到的 site id 清单。 */
export interface LoweredWorkflow {
  /** lowered 脚本的 async 函数体（顶层 await / 末尾 return 合法；自由标识符仅 `__host`）。 */
  code: string;
  /** 被打桩的 facade site id，按源码顺序（不含 log，它无 site id；留白与其函数体内的站点在内）。 */
  siteIds: string[];
  /**
   * 每个**已补全**留白的函数体文本 `(async () => {\n…\n})`，按站点 id：与主体同一趟 transform
   * 打印、同一套参数擦除（execution-engine.md「The text that runs」）。开放的留白不在其中。
   */
  holeBodies: Record<string, string>;
}

/** {@link lowerWorkflowScript} 的结果：与 analyze 同构——脏脚本不降级，`lowered` 仅在 `ok` 时给出。 */
export interface LowerResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  lowered?: LoweredWorkflow;
}

/** 每个被站点表登记的 facade 调用，改写成哪种 `__host.*`（`phase` 无 site id，只带名字）。 */
type SiteEmit =
  | { kind: "actor"; siteId: string }
  | { kind: "artifact"; siteId: string; op: ArtifactOp }
  | { kind: "ask"; siteId: string }
  /** 留白：改写要读名字 / 提示 / 函数体三个实参，所以带整个站点（lower-hole.ts）。 */
  | { kind: "hole"; site: HoleSite }
  /** 阶段标记：无 site id，只带去了两端空白的名字（名字缺席的标记退回 `void 0`）。 */
  | { kind: "phase"; name: string | undefined }
  | { kind: "report"; siteId: string }
  | { kind: "world-read"; siteId: string; op: WorldReadOp };

/**
 * 便捷入口：编译 + facade-siting 校验 + 收集站点表 + 降级，与 `analyzeWorkflowScript` 同构。
 * 脏脚本（typecheck 或 facade-siting 报错）不降级——降级只在干净程序上运行。
 */
export function lowerWorkflowScript(scriptText: string): LowerResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const table = collectSites(workflow);
  // 留白规则（9012）与 facade-siting 同席：一个没等值、或落在 fan-out 里的留白降级出去就是
  // 运行期的错，与 analyzeWorkflowScript 同一道门。
  const misuse = [
    ...collectFacadeMisuse(workflow, table),
    ...collectHoleDiagnostics(workflow, table),
  ];
  if (misuse.length > 0) return { diagnostics: misuse, ok: false };

  return { diagnostics, lowered: lowerWorkflow(workflow, table), ok: true };
}

/**
 * 核心：把一个已分析干净的 workflow 降级为 {@link LoweredWorkflow}。
 * 站点调用（ask/actor/world-read）一律按 **ts.Node 身份**（站点表持有的 raw call 引用）匹配，
 * 绝不按名字/形状重新识别——那会制造第二份真相。`log` 不入站点表，按 checker 的
 * 签名解析（解析进 facade .d.ts，与 sites.ts 同一机制）识别，属于身份判定而非名字启发。
 */
export function lowerWorkflow(workflow: WorkflowProgram, table: SiteTable): LoweredWorkflow {
  const checker = workflow.program.getTypeChecker();
  const siteMap = buildSiteMap(table);
  // 已补全留白的函数体（改写后的节点），transform 结束后打印成 holeBodies。
  const holeBodyNodes = new Map<string, ts.Expression>();

  // 第一趟：instrumentation。在同一份 scriptFile（站点表引用的正是它的节点）上做 transform，
  // 从而能按节点身份命中站点表；此时类型尚未擦除。
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const hostMember = (name: string): ts.Expression =>
      factory.createPropertyAccessExpression(factory.createIdentifier(HOST_BINDING), name);
    const siteArg = (id: string): ts.Expression => factory.createStringLiteral(id);

    const visit: ts.Visitor = (node) => {
      // `args` 是 facade 里唯一一个**值**而不是可调用物，所以它是唯一走标识符级改写的
      // 符号：读它不是一个等待点，没有站点、不进因果图。判定按 checker 解析结果（与站点
      // 身份同一机制），所以脚本自己声明的局部 `args` 解析到脚本文件的符号，原样保留。
      //
      // 刻意**不**改用「在包装函数体里注入 `const args = ...`」：用户脚本里再声明一个
      // `args` 会变成重复声明的运行期 SyntaxError，而编译期完全看不出来。
      if (ts.isIdentifier(node) && node.text === "args" && isFacadeArgsRead(node, checker)) {
        return hostMember("args");
      }
      if (ts.isCallExpression(node)) {
        const emit = siteMap.get(node);
        if (emit !== undefined) return lowerSited(node, emit);
        // 非站点的 facade 调用：log、channel、future（agent/ask/glob/read 必定成站点、已在 siteMap）。
        // 三者同规：按 checker 解析到 facade 声明的名字识别，改写成同名的 `__host.*`，丢弃类型
        // 实参（`channel<Fact>(...)`），实参原样递进。channel / future 是沙箱内的纯 promise 机制
        // （docs/dynamic-workflow/authoring.md「Streams」），不过线、无 journal 行，所以不需要站点 id。
        const name = facadeCalleeName(node, checker);
        // model("x") -> "x"：`ModelRef` 只活在类型系统里，运行期它就是名字字符串本身
        // （docs/dynamic-workflow/authoring.md「Choosing a model per subagent」），宿主按这个
        // 字符串查 launch 时解析好的绑定表。无站点、不过 host；实参缺席（9010 先挡）退回 `void 0`。
        if (name === "model") {
          const arg = node.arguments[0];
          return arg === undefined ? factory.createVoidZero() : visitExpr(arg);
        }
        if (name !== undefined && HOST_PASSTHROUGH_FUNCTIONS.has(name)) {
          return factory.createCallExpression(
            hostMember(name),
            undefined,
            node.arguments.map(visitExpr),
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };

    const visitExpr = (expr: ts.Expression): ts.Expression =>
      ts.visitNode(expr, visit) as ts.Expression;

    const lowerSited = (call: ts.CallExpression, emit: SiteEmit): ts.Expression => {
      if (emit.kind === "phase") {
        // phase("gate") -> __host.enterPhase("gate")。标记仍然**无站点、无 journal 行**——它不是一步工作；但控制流经过
        // 它这件事要让引擎看见（一条 `phase-entered` 事件），否则一个没有节点的阶段在时间线
        // 上永远是空圈。名字去两端空白，与分析器铸造阶段 id 的键同一；名字缺席（非字面量，
        // 9004 诊断本该先拦下）退回 `void 0`——沙箱里绝不能残留自由标识符 `phase`。
        const name = emit.name?.trim();
        if (name === undefined || name.length === 0) return factory.createVoidZero();
        return factory.createCallExpression(hostMember("enterPhase"), undefined, [
          factory.createStringLiteral(name),
        ]);
      }
      if (emit.kind === "hole") {
        return lowerHoleCall(
          call,
          emit.site,
          factory,
          hostMember,
          siteArg,
          visitExpr,
          holeBodyNodes,
        );
      }
      if (emit.kind === "actor") {
        // agent(name?, persona?) -> __host.createActor(siteId, name?, persona?)
        return factory.createCallExpression(hostMember("createActor"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      if (emit.kind === "ask") {
        // receiver.ask<T>(instr) -> __host.ask(siteId, receiver, instr)（丢弃类型实参 <T>）。
        // facade-siting 保证 ask 一定是 `receiver.ask(...)` 直接调用，故 callee 必为属性访问。
        const access = call.expression as ts.PropertyAccessExpression;
        const receiver = visitExpr(access.expression);
        const loweredAsk = (recv: ts.Expression): ts.Expression =>
          factory.createCallExpression(hostMember("ask"), undefined, [
            siteArg(emit.siteId),
            recv,
            ...call.arguments.map(visitExpr),
          ]);
        if (!ts.isOptionalChain(call)) return loweredAsk(receiver);
        // 可选链上的 ask（`p?.ask(x)`、`wrap?.p.ask(x)`）不能被无条件改写成
        // `__host.ask(siteId, <receiver>, x)`——`?.` 的短路被丢弃。receiver 为 nullish 时
        // 作者程序的语义是「跳过这次 ask，整条链结果 undefined」，而降级产物带着 undefined
        // 调进引擎，被判 UnknownActor **失败整个 run**——且只在可选分支真为空时发作，
        // 可能烧掉一整段长跑之后才炸。改写为 nullish 守卫三目：守卫命中时实参不求值，
        // 与可选链原语义一致；标识符 receiver 直接复读（无副作用），其余表达式经 hoisted
        // 临时变量恰好求值一次——与 tsc 自身降级可选链的做法同构。
        const once = ts.isIdentifier(receiver)
          ? receiver
          : factory.createTempVariable(context.hoistVariableDeclaration);
        const evaluated = once === receiver ? receiver : factory.createAssignment(once, receiver);
        const isNullish = factory.createBinaryExpression(
          factory.createBinaryExpression(
            evaluated,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createNull(),
          ),
          factory.createToken(ts.SyntaxKind.BarBarToken),
          factory.createBinaryExpression(
            once,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createIdentifier("undefined"),
          ),
        );
        return factory.createConditionalExpression(
          isNullish,
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createIdentifier("undefined"),
          factory.createToken(ts.SyntaxKind.ColonToken),
          loweredAsk(once),
        );
      }
      if (emit.kind === "artifact") {
        // artifact.file(id, path, opts)  -> __host.publishArtifact(siteId, "file", [id, path, opts])
        // artifact.chart(id, spec)       -> __host.declareArtifact(siteId, "chart", [id, spec])
        // 两族**同形不同名**：名字不同是因为两条路的返回类型不同（promise vs void），而
        // 引擎按方法名而不是按 op 分派——一个把声明当成效应去 await 的脚本，应该在类型层
        // 就被挡住，而不是在运行期拿到一个 undefined。实参与 world-read 同规：原样按位置
        // 打包进数组，lowering 不看 op、不校验元数（校验归引擎与 driver）。
        const member = isArtifactPresetOp(emit.op) ? "declareArtifact" : "publishArtifact";
        return factory.createCallExpression(hostMember(member), undefined, [
          siteArg(emit.siteId),
          factory.createStringLiteral(emit.op),
          factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
        ]);
      }
      if (emit.kind === "report") {
        // report(item, artifactId?) -> __host.report(siteId, item, artifactId?)
        // report 走**站点映射**而不是下面那条按 checker 名字识别的 log 路径：它是
        // 有站点的（journal 按 site × ordinal 去重 replay），而站点身份只在站点表里。
        return factory.createCallExpression(hostMember("report"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      // files.glob(arg)/files.read(arg) -> __host.worldRead(siteId, op, [arg])
      // 实参**原样按位置**打包进数组字面量：lowering 不看 op、不看元数、不做任何校验。每个 op 的元数与实参校验归 driver，
      // 所以加一个 world-read 原语在这一趟里是零改动。
      return factory.createCallExpression(hostMember("worldRead"), undefined, [
        siteArg(emit.siteId),
        factory.createStringLiteral(emit.op),
        factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
      ]);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const result = ts.transform(workflow.scriptFile, [transformer]);
  const transformed = result.transformed[0];
  if (transformed === undefined) throw new Error("lowering: transform produced no source file");

  // 只取 __workflowScript__ 的函数体语句（wrapper/facade/export 都不进 lowered code）。
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const instrumented = workflowBody(transformed)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
    .join("\n");
  const holeBodies = printHoleBodies(holeBodyNodes, printer, transformed);
  result.dispose();

  // 第二趟：类型擦除。此时打桩已完成、不再需要节点身份，故对文本做 transpile-级擦除即可。
  const code = ts.transpileModule(instrumented, {
    compilerOptions: TRANSPILE_OPTIONS,
    reportDiagnostics: false,
  }).outputText;

  return { code, holeBodies, siteIds: sourceOrderSiteIds(table) };
}

/**
 * 站点表的四类站点调用 + phase 标记，建成 `ts.CallExpression -> SiteEmit` 映射
 * （按节点身份匹配）。phase 走这张表是为了拿到节点身份与名字——它没有 site id，因此
 * 也不进 {@link sourceOrderSiteIds}。
 */
function buildSiteMap(table: SiteTable): Map<ts.CallExpression, SiteEmit> {
  const map = new Map<ts.CallExpression, SiteEmit>();
  for (const site of table.actors) map.set(site.call, { kind: "actor", siteId: site.id });
  for (const site of table.artifacts) {
    map.set(site.call, { kind: "artifact", op: site.op, siteId: site.id });
  }
  for (const site of table.asks) map.set(site.call, { kind: "ask", siteId: site.id });
  for (const site of table.holes) map.set(site.call, { kind: "hole", site });
  for (const marker of table.phases) map.set(marker.call, { kind: "phase", name: marker.name });
  for (const site of table.reports) map.set(site.call, { kind: "report", siteId: site.id });
  for (const site of table.worldReads) {
    map.set(site.call, { kind: "world-read", op: site.op, siteId: site.id });
  }
  return map;
}

/** 被打桩的 site id，按源码顺序（站点表的全局 `order` 发现序）。 */
function sourceOrderSiteIds(table: SiteTable): string[] {
  const sited = [
    ...table.actors,
    ...table.artifacts,
    ...table.asks,
    ...table.holes,
    ...table.reports,
    ...table.worldReads,
  ];
  return sited.sort((a, b) => a.order - b.order).map((site) => site.id);
}

/** 定位 transform 后的 __workflowScript__ 函数体语句（与 sites.ts 的 findWorkflowBody 同形）。 */
function workflowBody(sourceFile: ts.SourceFile): ts.NodeArray<ts.Statement> {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body.statements;
    }
  }
  throw new Error(`lowering: ${WORKFLOW_FUNCTION_NAME} not found in transformed source`);
}

/**
 * 调用解析到的 facade callable 名字（走 resolved signature 的声明，落在 facade .d.ts 内），
 * 否则 undefined。与 sites.ts 的私有 facadeCalleeName 同一思路——按签名声明的身份判定，
 * 而非 callee 表达式的拼写，故计算成员访问（`files["read"](x)`）也能解析到 facade 方法。
 * 本模块只用它认 log：站点类 facade 调用已先在 siteMap 命中并返回，不会走到这里。
 */

/**
 * True iff this `args` identifier is a READ of the facade global (not a shadowing local,
 * not a property name, not a declaration site).
 *
 * Identity comes from the checker, exactly as facade call sites do: a script that writes
 * its own `const args = ...` resolves to a symbol declared in the script file, so it is
 * left alone and keeps shadowing benignly. The syntactic guards below are for positions
 * where an identifier is not a value read at all — `x.args`, `{ args: 1 }`, and the name
 * in `const args = ...` — where rewriting would produce nonsense like `{ __host.args: 1 }`.
 */
function isFacadeArgsRead(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent !== undefined) {
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    // 声明位（`const args = ...`、参数名、import 名）：那是在**建**一个绑定，不是读 facade。
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
  }
  return isFacadeDeclared(resolveSymbol(node, checker));
}

function facadeCalleeName(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.getSourceFile().fileName !== FACADE_FILE_NAME) {
    return undefined;
  }
  const name = (declaration as ts.FunctionDeclaration | ts.MethodSignature).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
