/**
 * 留白站点（docs/dynamic-workflow/authoring.md「Holes: `hole<T>()`」，docs/analysis.md「Sites」）：
 * 站点的构造（三个重载的实参分派、tail 判定）与编译期规则 9012。
 *
 * 9012 的每条规则都是「运行期才炸不如现在就教改写」的那一类（与 9003 / 9004 同席）：
 *  - 类型实参必须显式写出：T 是补全被检查的契约，推断出的 `unknown` 不是契约；
 *  - 名字是非空字面量、≤128 字符，且在脚本的留白与阶段标记中**唯一**（嵌套补全也算）：名字
 *    是留白的阶段名与每个界面显示的身份——两个标记同名是一个阶段，两个留白同名却是两个缺口；
 *  - 调用必须被 await：没等值的留白会让脚本越过一个还没有值的缺口；
 *  - 不能落在 fan-out **回调**里（数组方法的回调，提升与否都算）：元素并发跑，补全得在它们
 *    已经在跑的时候写。`for...of` 体**允许**：带 await 的 for...of 是顺序的——第一轮停在留白，
 *    补全到了，后面每轮跑函数体，正是「循环里的留白补全一次、每轮跑一遍」那一条；
 *  - 函数体不得引用留白之后才声明的绑定：函数体是编译器不检查「先用后声明」的闭包，引用
 *    后面的 `const` 到运行期才 TDZ 抛错；
 *  - 函数体必须是内联的函数字面量：lowering 要把它原样打印成补全文本，一个标识符没有文本可打。
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { HoleSite, SiteTable } from "./sites.js";
import { literalText } from "./sites-labels.js";

/** 留白规则的诊断码（9001 = facade-siting、…、9010 = 模型名，顺延）。 */
export const HOLE_CODE = 9012;

/** 留白名的长度上限：与阶段名同规（docs/dynamic-workflow/authoring.md「Holes」）。 */
export const HOLE_NAME_MAX_CHARS = 128;

const TYPE_MESSAGE =
  "hole() needs an explicit type argument (hole<Plan>(...)): the type is the contract the " +
  "fill is compiled against, and an inferred unknown is no contract. Write what the rest of " +
  "the script needs from the hole.";

const NAME_LITERAL_MESSAGE =
  "hole()'s name must be a compile-time string literal: it is the hole's phase name and the " +
  "identity every surface shows (the station, the notification, the fill file). Write it inline.";

const NAME_EMPTY_MESSAGE =
  'hole("") has no name to show. Give the gap a word in the user\'s language ("决定分组", ' +
  '"choose the plan"); it labels the station and the notification.';

const NAME_LONG_MESSAGE = `hole()'s name is longer than ${HOLE_NAME_MAX_CHARS} characters; a phase name is a label, not a paragraph.`;

const AWAIT_MESSAGE =
  "hole() must be awaited where it is called (await hole<T>(...) or return await hole<T>(...)): " +
  "the script must not run past a gap that has no value yet.";

const FANOUT_MESSAGE =
  "hole() cannot stand inside a fan-out callback (xs.map(...), Promise.all(xs.map(...)) and the " +
  "other per-element array methods): the elements run concurrently, so its fill would have to " +
  "be written while they are already running. Hoist the decision out of the callback, or use a " +
  "loop (for, for...of, while), where one round waits and the fill runs in every later round.";

const BODY_INLINE_MESSAGE =
  "hole()'s body must be an inline async arrow (async () => { ... }): a fill is spliced into the " +
  "script as text, so a function held in a variable has nothing to splice.";

/** 名字撞车的文案：撞的是标记还是另一个留白，说清楚。 */
function duplicateMessage(name: string, other: "hole" | "marker"): string {
  return other === "hole"
    ? `two holes are named "${name}"; a hole's name is its identity and must be unique among the script's holes and phase markers.`
    : `hole "${name}" shares its name with a phase("${name}") marker; a hole is a phase of its own, so the name must be unique among holes and markers.`;
}

/** 两个不同名字的哈希撞车（hole-id.ts）：极罕见，但绝不猜——改一个名字就过。 */
function idCollisionMessage(name: string, other: string): string {
  return (
    `hole "${name}" and hole "${other}" hash to the same site id; rename one of them ` +
    "(any change to the name gives it a new id)."
  );
}

function lateBindingMessage(name: string): string {
  return (
    `the hole's body reads "${name}", which is declared after the hole. The body runs at the ` +
    "hole, before that declaration executes, so the read would throw at run time. Declare it " +
    "before the hole, or compute it inside the body."
  );
}

function isFunctionLiteral(
  expr: ts.Expression | undefined,
): expr is ts.ArrowFunction | ts.FunctionExpression {
  return expr !== undefined && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}

/** 调用是不是顶层 `return` 的操作数（`return await hole(...)` 或 `return hole(...)`）。 */
function isTailPosition(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (ts.isReturnStatement(parent)) return true;
  return ts.isAwaitExpression(parent) && ts.isReturnStatement(parent.parent);
}

/**
 * 从一个已按声明判定为 facade `hole` 的调用构造站点。三个重载的分派只看实参形状：第二实参是
 * 函数字面量即函数体，否则是提示；第三实参（若有）是函数体。非字面量的函数体既不算提示也不算
 * 函数体——留给 9012 报「必须内联」。
 */
export function holeSiteOf(
  call: ts.CallExpression,
  id: string,
  order: number,
  loc: ScriptLoc,
  funcDepth: number,
  fill: string | undefined,
): HoleSite {
  const [first, second, third] = call.arguments;
  const body = isFunctionLiteral(second) ? second : isFunctionLiteral(third) ? third : undefined;
  const prompt = second !== undefined && body !== second ? second : undefined;
  const typeArg = call.typeArguments?.[0];
  const name = literalText(first);
  return {
    call,
    ...(fill === undefined ? {} : { fill }),
    id,
    loc,
    ...(name === undefined ? {} : { name }),
    nameExpr: first,
    order,
    ...(prompt === undefined ? {} : { prompt }),
    ...(body === undefined ? {} : { body }),
    tail: funcDepth === 0 && isTailPosition(call),
    ...(typeArg === undefined ? {} : { typeArg, typeText: typeArg.getText() }),
  };
}

/** `node` 是否整体落在 `span` 节点的源码范围内。 */
function within(node: ts.Node, span: ts.Node, scriptFile: ts.SourceFile): boolean {
  return span.getStart(scriptFile) <= node.getStart(scriptFile) && node.getEnd() <= span.getEnd();
}

/**
 * 声明是否会被提升到作用域顶部，因而「先用后声明」在运行期无害：`function` 与 `var`。
 * `let` / `const` / `class` / `enum` 都不是（TDZ 或空对象），引用它们就是运行期错误。
 */
function isHoisted(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration)) return false;
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0;
}

/** 校验收集到的留白站点。非空即脚本不可提交（`analyzeWorkflowScript` 与 misuse 同席）。 */
export function collectHoleDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: HOLE_CODE, column: loc.column, line: loc.line, message });
  };
  const at = (node: ts.Node | undefined, fallback: ScriptLoc): ScriptLoc =>
    node === undefined ? fallback : toScriptLoc(node.getStart(scriptFile));

  // 名字的唯一性跨留白与标记：标记先登记，所以任何与标记同名的留白都被报出，不论先后；两个
  // 留白同名报在后一个上（源码序）。嵌套补全里的留白与标记也在表里，自然一并计入。
  const seen = new Map<string, "hole" | "marker">();
  for (const marker of table.phases) {
    const name = marker.name?.trim();
    if (name !== undefined && name !== "") seen.set(name, "marker");
  }
  // 名字键的哈希撞车：同一个 id 只能属于一个名字（同名的重复已经由上面那条报过）。
  const idOwner = new Map<string, string>();

  for (const site of [...table.holes].sort((a, b) => a.order - b.order)) {
    const nameLoc = at(site.nameExpr, site.loc);
    if (site.typeArg === undefined) push(site.loc, TYPE_MESSAGE);

    if (site.name === undefined) push(nameLoc, NAME_LITERAL_MESSAGE);
    else if (site.name.trim() === "") push(nameLoc, NAME_EMPTY_MESSAGE);
    else if (site.name.length > HOLE_NAME_MAX_CHARS) push(nameLoc, NAME_LONG_MESSAGE);
    else {
      const name = site.name.trim();
      const other = seen.get(name);
      if (other !== undefined) push(nameLoc, duplicateMessage(name, other));
      else {
        seen.set(name, "hole");
        const owner = idOwner.get(site.id);
        if (owner !== undefined && owner !== name) push(nameLoc, idCollisionMessage(name, owner));
        else idOwner.set(site.id, name);
      }
    }

    if (!ts.isAwaitExpression(site.call.parent)) push(site.loc, AWAIT_MESSAGE);

    // 只有数组方法回调（提升与否都算）；for...of 的语句体是顺序的，留白可以站在里面。
    const inCallback = table.iterations.some(
      (cand) => cand.form === "array-method" && within(site.call, cand.body, scriptFile),
    );
    if (inCallback) push(site.loc, FANOUT_MESSAGE);

    // 非内联的函数体：第二实参不是提示（不是 string）且不是字面量，或第三实参不是字面量。
    const [, second, third] = site.call.arguments;
    const heldBody =
      (third !== undefined && site.body !== third ? third : undefined) ??
      (second !== undefined && site.prompt === second && isCallable(second, checker)
        ? second
        : undefined);
    if (heldBody !== undefined) push(at(heldBody, site.loc), BODY_INLINE_MESSAGE);

    if (site.body !== undefined) {
      collectLateBindings(site.call, site.body, checker, scriptFile, (node, name) =>
        push(at(node, site.loc), lateBindingMessage(name)),
      );
    }
  }
  return diagnostics;
}

function isCallable(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return checker.getTypeAtLocation(expr).getCallSignatures().length > 0;
}

/**
 * 函数体里每一个解析到「留白之后、函数体之外、不被提升」的脚本声明的标识符引用，每个绑定
 * 报一次（首次引用处）。属性名与声明位不是引用，跳过。
 */
function collectLateBindings(
  call: ts.CallExpression,
  body: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  scriptFile: ts.SourceFile,
  report: (node: ts.Node, name: string) => void,
): void {
  const holeStart = call.getStart(scriptFile);
  const reported = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !reported.has(symbol)) {
        const late = symbol.declarations?.some(
          (decl) =>
            decl.getSourceFile() === scriptFile &&
            !within(decl, body, scriptFile) &&
            decl.getStart(scriptFile) > holeStart &&
            !isHoisted(decl),
        );
        if (late === true) {
          reported.add(symbol);
          report(node, node.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body.body);
}

/** 标识符是不是一次值引用（不是 `x.NAME` 的成员名、不是声明自己的名字、不是属性键）。 */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
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
  return true;
}
