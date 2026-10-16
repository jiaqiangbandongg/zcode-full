/**
 * 具名 actor 重名的编译期 courtesy 诊断。
 *
 * 规则本身是**运行期**的：引擎在 createActor 查非空有效名的重复，撞上即 run 级失败
 * （`DuplicateActorName`）。理由是具名 actor 是修订续跑（amend-resume）缓存导入的身份键，
 * 而任何 run 都是未来修订的潜在前驱——前驱里重名会让导入匹配歧义。
 *
 * 这里做**字面量能看穿的那一半**，两条子句：
 *
 * 1. **两处同名**：两个 `agent(...)` 站点的有效名是同一个字符串字面量时，在后一处报一条可
 *    定位的诊断，让作者在便宜的那一侧改名，而不是跑到一半失败。任何动态成分
 *    （`` `worker-${i}` ``、标识符、展开、shorthand 属性）一律跳过——那些只有运行期能查。
 * 2. **fan-out 里的静态名**：一个 `agent("x")` 站点跑在 fan-out 体内时，每个元素都建一个新
 *    actor 而它们共用同一个名字——一个站点，N 次重名，运行期必然大声失败。
 *
 * 子句 1 **只会漏报、不会误报**：跳过一个可能重名的站点没有代价（引擎兜底），而误伤一个
 * 合法脚本会挡住提交。
 *
 * `.map` 的集合可能只有 ≤1 个
 * 元素，那样的脚本在运行期其实合法，所以这条子句理论上会误报。接受它的理由是代价不对称——
 * 修复是免费的（改成逐元素名 `` `x-${item}` `` 或匿名），而不报的代价是模型烧掉一整个 run
 * 才学到这条规则。`paths.map((p) => agent("reviewer").ask(…))` 正是 fan-out 的教科书写法，
 * 沉默地留给运行期是最坏的一档。
 *
 * fan-out 的判定**复用站点表的分类**（`analysis/sites.ts` 的 `IterationCandidate`：带内联
 * 回调的数组方法 + `for...of`），不自己再造一套循环识别。代价是普通 `for` / `while` /
 * `do` 循环不在那张分类里，因而不被本子句覆盖——它们回落到子句 1 的老姿态（看不见，归运行期）。
 * 那正是漏报方向，与本模块的保守取向一致。
 *
 * `CreateWorkflow` 与
 * `SaveWorkflow` 两个 handler 都先走 `analyzeScript`（本诊断在 `analyzeWorkflowScript` 的
 * authoring 批次里），`!ok` 即带诊断早返回、**不 submit / 不落盘**，所以一条 9005/9006 确实
 * 挡住提交与保存。但 run service 的 `compileOnce`（submit 与 resume 的重编译）只复验
 * typecheck / schema / world.run 字面量三项，**不含**本诊断——所以它不是 submit 路径上的
 * 强制门，别把它当承重结构：具名唯一性的权威始终是引擎 createActor 的运行期查重。
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** 两处字面量同名（子句 1）。9001 = facade-siting、9002 = schema、9003 = world-run、9004 = phase。 */
export const DUPLICATE_ACTOR_NAME_CODE = 9005;

/**
 * fan-out 体内的静态名（子句 2），单独一个码而不是复用 9005。
 *
 * 两条子句是同一条规则，但**确定性不同**：9005 只在静态确定重名时出现，9006 是上面那条刻意
 * 接受误报的子句。读端因此需要能区分它们——特别是分析侧的 fixture 语料：
 * 那些脚本从不执行，只用来钉图形状，其中静态名 + fan-out 的组合恰恰是**分析器必须正确处理**
 * 的形状（`ActorNode.family`、actor 标签），所以语料要豁免 9006 而对 9005 保持严格。
 * 共用一个码就只能靠匹配 message 文本来区分，而按错误文本分流正是本仓库处处禁止的。
 */
export const FANOUT_ACTOR_NAME_CODE = 9006;

/**
 * 收集字面量重名诊断。非空即脚本不可提交（`analyzeWorkflowScript` 与 world.run / phase
 * 的编译期规则同席）。
 */
export function collectDuplicateActorNames(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const claimed = new Map<string, ts.CallExpression>();
  // fan-out 体的集合来自站点表的 IterationCandidate（数组方法的内联回调体 + for...of 的
  // 循环体），与 `ActorNode.fanOutId` 判定「站点是否落在 fan-out 体内」用的是同一个概念。
  const fanOutBodies = new Set<ts.Node>(table.iterations.map((iteration) => iteration.body));
  for (const site of table.actors) {
    // 站点表的 `site.name` 在这里**用不得**：它会退回到绑定名（`const planner = agent()`
    // 记作 "planner"），那是给图用的展示标签，不是运行期的有效名。这里要的是引擎会看见的
    // 那个值，所以自己从实参读。
    const name = staticEffectiveName(site.call);
    if (name === undefined || name === "") continue;
    const first = claimed.get(name);
    if (first === undefined) claimed.set(name, site.call);
    const loc = workflow.toScriptLoc(site.call.getStart(workflow.scriptFile));
    // 一个站点最多报一条：fan-out 子句更具体（它连修法都不同——逐元素名而不是换个名字），
    // 所以它优先。名字仍照常登记，后面同名的站点该报还报。
    if (isInsideFanOut(site.call, fanOutBodies)) {
      diagnostics.push({
        code: FANOUT_ACTOR_NAME_CODE,
        column: loc.column,
        line: loc.line,
        message:
          `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed ` +
          `string, so every element creates a different actor under the same name — the run ` +
          `fails with DuplicateActorName as soon as the collection holds more than one item. ` +
          `An actor name must be unique within a run: it is the identity key an amended re-run ` +
          `matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), ` +
          `or drop the name — anonymous actors are legal (they just never reuse cached work).`,
      });
      continue;
    }
    if (first === undefined) continue;
    // 诊断落在**后一处**：先出现的那个名字是既有事实，要改的是后来的这一个。
    const firstLoc = workflow.toScriptLoc(first.getStart(workflow.scriptFile));
    diagnostics.push({
      code: DUPLICATE_ACTOR_NAME_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `two actors are named "${name}" (the first is on line ${firstLoc.line}): an actor name ` +
        `must be unique within a run. The name is the identity key an amended re-run matches ` +
        `its imported cache against, and any run can become the predecessor of one, so a ` +
        `repeated name makes that match ambiguous. Give this one its own name, or drop the ` +
        `name entirely — anonymous actors are legal (they just never reuse cached work).`,
    });
  }
  return diagnostics;
}

/**
 * 该调用是否**词法上**落在某个 fan-out 体内。从调用本身起走父链（调用可以就是体本身：
 * `paths.map((p) => agent("x"))` 的箭头简写体），命中任一候选体即是。
 */
function isInsideFanOut(call: ts.CallExpression, fanOutBodies: ReadonlySet<ts.Node>): boolean {
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (fanOutBodies.has(node)) return true;
  }
  return false;
}

/**
 * 一个 `agent(...)` 调用静态可知的**有效名**，否则 undefined（= 跳过）。
 *
 * 与引擎的 `normalizePersona` 同一条规则：persona.name 压过 name 实参；字符串 persona 是
 * system prompt、不带名字。任何一处看不穿就整体放弃——宁可漏报。
 *
 * facade 的 `AgentPersona` **今天不声明 name**，所以脚本写得出的 persona 从不带名字，有效名
 * 一律落到 name 实参。persona 这一段因此现在从不触发；留着是为了与 normalizePersona 同步，
 * 而不是为了今天生效——一旦 facade 长出 name 而这里还按 name 实参判定，一个被 persona 改过名
 * 的 actor 就会被**误报**，而误报会挡住合法脚本（漏报没有代价：引擎运行期兜底）。
 */
function staticEffectiveName(call: ts.CallExpression): string | undefined {
  const [nameArg, personaArg] = call.arguments;
  if (personaArg !== undefined && !ts.isStringLiteralLike(personaArg)) {
    if (!ts.isObjectLiteralExpression(personaArg)) return undefined; // 动态 persona：可能带 name
    for (const property of personaArg.properties) {
      // 展开可能带进一个 name，静态说不准。
      if (ts.isSpreadAssignment(property)) return undefined;
      // 计算键（`{ ["na" + "me"]: … }`）也说不准：它**可能就是** name。这里必须整体放弃而
      // 不是 `continue`——continue 会落回 name 实参，等于断言 persona 没有改名，那是一次
      // 猜测，而猜错的方向恰好是误报（挡住合法脚本）。
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name === undefined || !isNameKey(property.name)) continue;
      if (!ts.isPropertyAssignment(property)) return undefined; // shorthand / 方法：动态
      return ts.isStringLiteralLike(property.initializer)
        ? property.initializer.text
        : undefined;
    }
    // 对象字面量里没有 name，落回 name 实参。
  }
  return nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
}

/** 属性键是否**静态确定**就是 `name`（计算键在调用点已整体放弃，不走这里）。 */
function isNameKey(key: ts.PropertyName): boolean {
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "name";
}
