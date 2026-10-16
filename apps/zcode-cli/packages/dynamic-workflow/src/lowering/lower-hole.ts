import ts from "typescript";
import type { HoleSite } from "../analysis/sites.js";

/**
 * 留白的降级（execution-engine.md「From script to sandbox input: lowering」的两行 hole，
 * 与「The vm cell」）：
 *
 *   hole<T>(n, p?)                 -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src))
 *   hole<T>(n, p?, async () => …)  -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src),
 *                                                 async () => { …lowered body… })
 *
 * 最后那个 `(__src) => eval(__src)` 是**在站点处**发出的求值器：它的 `eval` 是直接调用，所以
 * 补全的文本在留白的词法作用域里求值——能读到留白之前的每个绑定、`__host` 也在内；每次到达
 * 都新造一个求值器，循环里的留白因此拿到每一轮的绑定。已补全的留白把函数体当第五个实参传过
 * 去，cell 直接调用它、不发消息。
 *
 * 从 lower.ts 拆出（max-lines 门），且刻意只做纯函数：改写按站点表给的节点身份走，与其余
 * 站点同一趟 transform，不再识别第二遍。
 */

/** 求值器的形参名：cell 把补全文本喂给它。 */
const EVALUATOR_PARAM = "__src";

/** 两趟降级共用的擦除选项：主体与留白函数体必须由**同一套**参数产出（execution-engine.md「The text that runs」）。 */
export const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  isolatedModules: false,
  module: ts.ModuleKind.ESNext,
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
  target: ts.ScriptTarget.ES2022,
};

/** 一次留白调用的改写；已补全的留白把改写后的函数体记进 `bodies`，供 {@link printHoleBodies} 打印。 */
export function lowerHoleCall(
  call: ts.CallExpression,
  site: HoleSite,
  factory: ts.NodeFactory,
  hostMember: (name: string) => ts.Expression,
  siteArg: (id: string) => ts.Expression,
  visitExpr: (expr: ts.Expression) => ts.Expression,
  bodies: Map<string, ts.Expression>,
): ts.Expression {
  const [first] = call.arguments;
  const name = first === undefined ? factory.createVoidZero() : visitExpr(first);
  const prompt = site.prompt === undefined ? factory.createVoidZero() : visitExpr(site.prompt);
  const evaluator = factory.createArrowFunction(
    undefined,
    undefined,
    [factory.createParameterDeclaration(undefined, undefined, EVALUATOR_PARAM)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    factory.createCallExpression(factory.createIdentifier("eval"), undefined, [
      factory.createIdentifier(EVALUATOR_PARAM),
    ]),
  );
  const args: ts.Expression[] = [siteArg(site.id), name, prompt, evaluator];
  if (site.body !== undefined) {
    const body = visitExpr(site.body);
    bodies.set(site.id, body);
    args.push(body);
  }
  return factory.createCallExpression(hostMember("hole"), undefined, args);
}

/**
 * 每个已补全留白的函数体，作为**打印过、擦除过类型**的文本 `(async () => {\n…\n})`：活的补全
 * 让 cell 对它 `eval`，之后的 replay 则跑主体里内联的同一份改写——两条路的每个站点都带同样的
 * `hole#<hash>/…` id，因为文本来自同一趟 transform（execution-engine.md「The text that runs」）。
 *
 * 打印成表达式语句再擦除，尾随的 `;\n` 是 transpile 加的语句结束，去掉——留下的就是一个可以
 * 直接 `eval` 成函数值的括号表达式。
 */
export function printHoleBodies(
  bodies: ReadonlyMap<string, ts.Expression>,
  printer: ts.Printer,
  sourceFile: ts.SourceFile,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [siteId, body] of bodies) {
    const printed = printer.printNode(ts.EmitHint.Expression, body, sourceFile);
    const erased = ts.transpileModule(`(${printed})`, {
      compilerOptions: TRANSPILE_OPTIONS,
      reportDiagnostics: false,
    }).outputText;
    out[siteId] = erased.replace(/;\n?$/, "");
  }
  return out;
}
