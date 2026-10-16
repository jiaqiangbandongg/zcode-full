/**
 * 产物（artifact）的编译期收集与诊断。
 *
 * ⚠ 术语：本模块的 artifact 是**用户面产物**——脚本经 `artifact.*` 发布给用户看的文件 /
 * markdown / 预置看板。同目录下的 `artifact-types.ts` 说的是**另一个** artifact：站点的
 * 类型化输出值（给模型看的）。两者不相干。
 *
 * 产物两件：
 *
 * 1. `declaredArtifacts`（编译产物，照 `collectWorldRunCommands` 的 `commands`）：脚本声明的
 *    产物清单 `[{id, kind}]`，去重、按 id 排序。中枢与检视器据它在**运行前**就能说出这个
 *    工作流会产出什么。
 * 2. 定位诊断（facade-misuse 同族）：id 必须是编译期字面量，标签必须指向一个已声明的预置，
 *    同一个 id 不能横跨两个成员种类，预置声明不该长在循环体 / 回调 / 条件分支里。
 *
 * 为什么 id 必须是编译期字面量（与 `world.run` 的 cmd、`phase` 的 name 同一姿态）：一个运行期
 * 才成形的 id 没有可展示的对象——它既进不了「将产出」清单，也让「同 id 两种种类」这类规则
 * 只剩运行期一条路。教改写发生在便宜的那一侧。
 *
 * 与运行期的分工：这一趟只做**字面量能看穿的那一半**。真正的门在引擎——`ArtifactKindMismatch`
 * /`ArtifactRedeclared`/`ArtifactUndeclared`/`ArtifactCapExceeded` 都在运行期兜底，因为
 * 声明的**执行顺序**（哪个先跑到）静态看不出来。所以本模块**只会漏报、不会误报**，
 * 唯一的例外是提升诊断（见 {@link ARTIFACT_HOISTING_CODE}）。
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "../facade/artifact-caps.js";
import { isArtifactPresetOp, type ArtifactOp } from "../facade/registry.js";
import { findWorkflowBody, type ArtifactSite, type SiteTable } from "./sites.js";

/**
 * 产物的编译期诊断码（9001 = facade-siting、9002 = schema、9003 = world-run、9004 = phase、
 * 9005/9006 = actor 名，顺延）。覆盖：非字面量 / 空 / 超长 / 非法字符的 id、同 id 跨种类复用、
 * `report` 标签的三种错法。全部是**静态确定**的错误——没有一条会误伤一份合法脚本。
 */
export const ARTIFACT_DECLARATION_CODE = 9007;

/**
 * 预置声明长在循环体 / 回调 / 条件分支里（「声明提到顶层，一次即可」），单独一个码而不是
 * 复用 9007，理由与 9005/9006 的分家完全相同：**确定性不同**。
 *
 * 循环里以**相同 spec** 重复声明在运行期其实是幂等 no-op，所以这条子句理论上会误报。接受它
 * 的理由是代价不对称——修复是免费的（把声明挪到脚本顶部），而不报的代价是一个看板声明藏在
 * 第三层回调里，读者要跑一遍才知道它到底声明了没有。读端（fixture 语料、未来的宽松档）
 * 因此需要能把它与 9007 区分开，而按错误文本分流是本仓库处处禁止的。
 */
export const ARTIFACT_HOISTING_CODE = 9008;

/**
 * 两个**不同的** id 都写了字面量 `primary: true`。
 * 与 9008 同一种确定性：互斥分支里各标一个在运行期跑得通，但卡与侧板只会带头一个交付物，
 * 说不清哪个是的脚本没写完。只认字面量 `true`；算出来的旗子留给引擎的 `ArtifactPrimaryConflict`。
 */
export const ARTIFACT_PRIMARY_CONFLICT_CODE = 9009;

/** 脚本声明的一个产物：id 与它的成员种类。 */
export interface DeclaredArtifact {
  id: string;
  /** 成员种类（`file` / `markdown` / `chart` / `table` / `metrics` / `board`）。 */
  kind: ArtifactOp;
}

export interface ArtifactDeclarations {
  /** 脚本声明的产物清单：去重、按 id 字典序（`declaredCommands` 的同形产物）。 */
  declaredArtifacts: DeclaredArtifact[];
  /** 定位诊断；非空即脚本不可提交。 */
  diagnostics: CompileDiagnostic[];
}

/** 预置声明所处的、不该待的词法位置。 */
type HoistingContext = "loop" | "callback" | "conditional";

const HOISTING_MESSAGE: Record<HoistingContext, string> = {
  callback:
    "a preset artifact declared inside a callback: hoist it to the top level and declare it once. " +
    "A preset is a declaration, not a step — it says how the items tagged with its id are drawn, " +
    "and the tagged report() calls are what fill it in. Declaring it where the callback runs " +
    'buries it: move artifact.<kind>("<id>", spec) to the head of the script and keep only ' +
    'report(item, "<id>") in the callback.',
  conditional:
    "a preset artifact declared inside a conditional branch: hoist it to the top level and declare " +
    "it once. The card should exist from the moment the run starts (it is legitimately empty until " +
    "the first tagged report arrives), and a declaration that may or may not have run is a card " +
    "that may or may not exist. Declare it unconditionally and let the branch decide what to report.",
  loop:
    "a preset artifact declared inside a loop: hoist it to the top level and declare it once. " +
    "A preset is declared once and fed many times — the loop body is where report(item, \"<id>\") " +
    "belongs, not the declaration. Re-declaring the same spec is a no-op, but re-declaring it with " +
    "a different spec fails the whole run, so the loop is the wrong place for it either way.",
};

const NON_LITERAL_ID_MESSAGE =
  "an artifact id must be a compile-time string literal (\"report\" or a no-substitution template): " +
  "the set of artifacts a run can publish is fixed when the script is submitted, so it can be listed " +
  "before anything runs. Write the id inline; put the runtime value in the title instead " +
  '(artifact.file("report", path, { title: `Report for ${name}` })).';

const EMPTY_ID_MESSAGE =
  "an artifact id must not be empty: it is the identity the card, the version history and the " +
  'report tag all key off. Give it a short stable name ("book", "perf", "coverage").';

/**
 * 收集产物清单与诊断。非空诊断即脚本不可提交（`analyzeWorkflowScript` 与 world.run / phase /
 * actor 名的编译期规则同席）。
 */
export function collectArtifactDeclarations(
  workflow: WorkflowProgram,
  table: SiteTable,
): ArtifactDeclarations {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (code: number, loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code, column: loc.column, line: loc.line, message });
  };
  const locOf = (node: ts.Node): ScriptLoc =>
    workflow.toScriptLoc(node.getStart(workflow.scriptFile));

  const body = findWorkflowBody(workflow.scriptFile);
  /** 已补全留白的函数体：不是回调，提升诊断看穿它们（见 {@link hoistingContextOf}）。 */
  const holeBodies = new Set<ts.Node>(table.holes.flatMap((hole) => hole.body ?? []));
  /** id → 第一个用它的站点（种类冲突时用来指认前一处）。 */
  const claimed = new Map<string, ArtifactSite>();
  /** 第一个写了字面量 `primary: true` 的站点；第二个不同 id 再写就是 9009。 */
  let primaryClaim: { id: string; site: ArtifactSite } | undefined;
  const declared: DeclaredArtifact[] = [];

  for (const site of table.artifacts) {
    // id 的诊断落在**出问题的那个表达式**上（缺席时退回站点位置，同 world-run 的处理：
    // 元数错误由类型检查先拦，但诊断收集不该依赖那条推断）。
    const idLoc = site.artifactIdExpr === undefined ? site.loc : locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(ARTIFACT_DECLARATION_CODE, idLoc, NON_LITERAL_ID_MESSAGE);
      continue;
    }
    const id = site.artifactId;
    if (id === "") {
      push(ARTIFACT_DECLARATION_CODE, idLoc, EMPTY_ID_MESSAGE);
      continue;
    }
    if (id.length > ARTIFACT_CAPS.maxIdLength) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" is ${id.length} characters; the limit is ${ARTIFACT_CAPS.maxIdLength}. ` +
          "The id is a key, not a description — put the prose in the title.",
      );
      continue;
    }
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" contains characters outside [A-Za-z0-9_.-]. The id is carried verbatim ` +
          "through the journal, the artifact store and the side pane, so it is restricted to " +
          'characters that need no escaping anywhere ("build-log", "perf.p95").',
      );
      continue;
    }

    // 跨成员种类复用（诊断 4）：诊断落在**后一处**——先出现的那个种类是既有事实。
    const first = claimed.get(id);
    if (first === undefined) {
      claimed.set(id, site);
      declared.push({ id, kind: site.op });
    } else if (first.op !== site.op) {
      push(
        ARTIFACT_DECLARATION_CODE,
        site.loc,
        `artifact id "${id}" is used with two different kinds: artifact.${first.op} on line ` +
          `${first.loc.line} and artifact.${site.op} here. Within one run an id belongs to exactly ` +
          "one kind — publishing it again is what mints the next VERSION, and a version cannot " +
          "change what the thing is. Give this one its own id.",
      );
    }

    // 交付物唯一（9009）：诊断落在**后一处**的 `primary` 属性上——先标的那个是既有事实。
    const primaryNode = primaryLiteralOf(site);
    if (primaryNode !== undefined) {
      if (primaryClaim === undefined) primaryClaim = { id, site };
      else if (primaryClaim.id !== id) {
        push(
          ARTIFACT_PRIMARY_CONFLICT_CODE,
          locOf(primaryNode),
          `artifact "${id}" is marked primary, but "${primaryClaim.id}" already is (artifact.` +
            `${primaryClaim.site.op} on line ${primaryClaim.site.loc.line}). A run has one ` +
            "deliverable — the card and the run pane lead with it. Drop primary from one of them, " +
            "or publish this content as a new version of the other id.",
        );
      }
    }

    // 提升诊断（预置族专属）：内容成员反而**常常**该出现在循环 / 条件里（每轮发布一版、
    // 失败时补一版），所以这条子句绝不能扩到那一族。
    if (isArtifactPresetOp(site.op)) {
      const context = hoistingContextOf(site.call, body, holeBodies);
      if (context !== undefined) {
        push(ARTIFACT_HOISTING_CODE, site.loc, HOISTING_MESSAGE[context]);
      }
    }
  }

  // 已声明的**预置** id（标签的合法目标集）与内容 id，两张表分开：标签指向内容 id 有专门
  // 的一条文案（它不是「没这个东西」，而是「这个东西没有数据面」）。
  const presetIds = declared.filter((entry) => isArtifactPresetOp(entry.kind)).map((e) => e.id);
  const contentIds = new Set(
    declared.filter((entry) => !isArtifactPresetOp(entry.kind)).map((e) => e.id),
  );

  for (const site of table.reports) {
    if (site.artifactIdExpr === undefined) continue; // 无标签的 report 照旧
    const tagLoc = locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        "report()'s artifact tag must be a compile-time string literal naming a preset artifact " +
          "declared in this script: the tag is how an item finds its dashboard, and a tag that only " +
          "exists at run time cannot be checked against the declarations. Write the id inline.",
      );
      continue;
    }
    const tag = site.artifactId;
    if (presetIds.includes(tag)) continue;
    if (contentIds.has(tag)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        `report()'s tag "${tag}" names a file/markdown artifact, which holds content rather than a ` +
          "stream of items — there is nothing for this item to become. Tag the item with a preset " +
          "artifact (chart / table / metrics / board), or drop the tag and let the item go to the " +
          "run's Results.",
      );
      continue;
    }
    push(
      ARTIFACT_DECLARATION_CODE,
      tagLoc,
      `report()'s tag "${tag}" names no preset artifact declared in this script${describePresets(presetIds)}. ` +
        'Declare it first — artifact.chart("' +
        tag +
        '", { x, y }) at the top of the script — or drop the tag.',
    );
  }

  return { declaredArtifacts: sortDeclared(declared), diagnostics };
}

/**
 * 站点 opts / spec 实参里字面量写着 `primary: true` 的那个属性；没有、不是对象字面量、不是
 * 字面量 `true`（算出来的、展开进来的）都算没有——那一半留给引擎。
 */
function primaryLiteralOf(site: ArtifactSite): ts.Node | undefined {
  const arg = site.call.arguments[isArtifactPresetOp(site.op) ? 1 : 2];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const property of arg.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (key !== "primary") continue;
    return property.initializer.kind === ts.SyntaxKind.TrueKeyword ? property : undefined;
  }
  return undefined;
}

/** 「已声明的预置有：…」的尾巴；一个都没有时说得更直白。 */
function describePresets(presetIds: readonly string[]): string {
  if (presetIds.length === 0) return " (this script declares no preset artifacts at all)";
  return ` (declared presets: ${[...presetIds].sort().map((id) => `"${id}"`).join(", ")})`;
}

/** 去重（同 id 同种类只留一条）、按 id 字典序。 */
function sortDeclared(declared: readonly DeclaredArtifact[]): DeclaredArtifact[] {
  const seen = new Set<string>();
  const unique: DeclaredArtifact[] = [];
  for (const entry of declared) {
    const key = `${entry.id} ${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => (a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1));
}

/**
 * 该调用**词法上**待在哪种不该待的位置里，从调用向外走到脚本体为止；都不是则 undefined。
 * 报最内层的那一个：它离作者要改的那一行最近，文案也最具体。
 *
 * 刻意**不**把普通函数声明算作回调：`function setup() { artifact.chart(...) }` 后跟一次
 * `setup()` 是一份合法的顶层声明，只是换了个写法。箭头函数与函数表达式则几乎总是回调
 * （`.map(...)`、`.then(...)`），所以它们算。代价是「在具名 helper 里声明、而 helper 被
 * 循环调用」这一形状漏报——那是漏报方向，与本模块的保守取向一致（引擎的
 * `ArtifactRedeclared` 仍然兜底）。
 *
 * 已补全留白的函数体（`holeBodies`）**不算**回调：它被拼在留白所在的位置、每次到达跑一遍，与
 * 周围的语句同级，所以这里看穿它，继续往外找——留白自己待在循环 / 分支里时照样报。
 * 修复原因（2026-09-29 testfield 实测）：此前一切箭头都算回调，补全体恰好是箭头，于是没有一次
 * 补全能为它写下的那一段声明看板，主代理只能放弃。
 */
function hoistingContextOf(
  call: ts.CallExpression,
  body: ts.Block,
  holeBodies: ReadonlySet<ts.Node>,
): HoistingContext | undefined {
  let child: ts.Node = call;
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (node === body) return undefined;
    if (holeBodies.has(node)) {
      child = node;
      continue;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      return "callback";
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      return "loop";
    }
    // if / ternary：只有**分支**算条件位置，条件表达式本身不算——`if (artifact.chart(...))`
    // 无条件求值，它的问题是别的（一个 void 当条件用），不该借这条文案说。
    if (ts.isIfStatement(node) && (node.thenStatement === child || node.elseStatement === child)) {
      return "conditional";
    }
    if (ts.isConditionalExpression(node) && (node.whenTrue === child || node.whenFalse === child)) {
      return "conditional";
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return "conditional";
    child = node;
  }
  return undefined;
}
