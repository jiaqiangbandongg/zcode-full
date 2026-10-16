// ============================================================
// Dynamic Workflow Run 的留白（docs/execution-engine.md「Holes」）：编译产物、快照投影与诊断映射
// ============================================================
// 留白在宿主侧有三个读面：`run-launched.holes`（阶段表里哪些站是开放的留白）、快照与详情上的
// `holes[]`（谁在等、谁补过），以及补全被拒时的诊断（落在函数体内还是草稿里）。三者都只依赖
// 编译产物（站点表）与 journal 事件，不碰引擎——引擎的停驻表由调用方经控制面读好递进来。
// 本文件因此是纯合成规则（无 I/O、无状态），与 dynamic-workflow-run-observation.ts 同一纪律。

import type {
  DynamicWorkflowRunFillHoleDiagnostic,
  DynamicWorkflowRunHole,
} from "@zcode/contracts";
import {
  collectSites,
  createWorkflowProgram,
  MODEL_UNRESOLVED_CODE,
  type CompileDiagnostic,
  type JournalStorePort,
  type ModelReference,
  type OpenHole,
  type RunEvent,
  type SiteTable,
  type StoredEvent,
} from "@zcode/dynamic-workflow";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";

/**
 * 快照上留白条数的上限（contracts 的 `DynamicWorkflowRunHole` 注释：≤32）。一个站点在循环里
 * 可以到达多次，每次一条；超出的是同一个站点的重复到达，读者从前 32 条已经知道它在等。
 */
const SNAPSHOT_MAX_HOLES = 32;

/** 类型实参缺席时的占位（9012 要求显式类型实参，只有绕过分析器的脚本才会走到这里）。 */
const UNKNOWN_HOLE_TYPE = "unknown";

/**
 * 一处留白的编译期事实：站点 id、字面名、类型实参原文、调用所在的脚本行，以及此刻开放与否。
 * 从站点表抄下来而不是持有站点表本身：`SiteTable` 挂着整棵 AST，注册表条目要活到 run 结算。
 */
export interface CompiledHole {
  siteId: string;
  name: string;
  type: string;
  /** `hole(...)` 调用在脚本里的行号（1 起）。 */
  line: number;
  /** 没有函数体 = 开放的留白；补全后变成 false，嵌套在体内的新留白随之出现在表里。 */
  open: boolean;
}

/** 站点表 → 留白的编译期事实表（源码序，开放与已补全都在）。 */
export function compiledHolesOf(table: SiteTable): CompiledHole[] {
  return table.holes.map((site) => ({
    siteId: site.id,
    name: site.name ?? site.id,
    type: site.typeText ?? UNKNOWN_HOLE_TYPE,
    line: site.loc.line,
    open: site.body === undefined,
  }));
}

/**
 * `run-launched.holes`：声明阶段表里哪些下标是**开放的留白**（docs/execution-engine.md「Holes」）。
 * 留白按名字站在阶段表里（9012 保证留白名与阶段标记名互不重复），所以按名字对得上就是它。
 * 阶段表缺席或没有开放留白时回 `undefined`——字段整个缺席，与 `phaseAlongside` 同规。
 */
export function openHoleIndexes(
  phaseNames: readonly string[] | undefined,
  holes: readonly CompiledHole[],
): number[] | undefined {
  if (phaseNames === undefined) return undefined;
  const open = new Set(holes.filter((hole) => hole.open).map((hole) => hole.name));
  const indexes: number[] = [];
  phaseNames.forEach((name, index) => {
    if (open.has(name)) indexes.push(index);
  });
  return indexes.length === 0 ? undefined : indexes;
}

/** 快照投影要读的两类事件；`reportItems: {limit: 0}` 是这条读面的固定形状（不碰 report 行）。 */
const HOLE_EVENT_TYPES: RunEvent["type"][] = ["hole-reached", "hole-filled", "run-launched"];

type HoleReachedEvent = Extract<RunEvent, { type: "hole-reached" }>;
type HoleFilledEvent = Extract<RunEvent, { type: "hole-filled" }>;

/** 快照投影的事件读：留白事件与首条 `run-launched`（阶段表的冷来源），一次有类型过滤的窄读。 */
export function readRunHoleEvents(journal: JournalStorePort, runId: string): StoredEvent[] {
  return journal.listEvents(runId, { types: HOLE_EVENT_TYPES, reportItems: { limit: 0 } });
}

/**
 * 从这批事件里读出**此刻生效**的阶段表：最后一条 `hole-filled` 带的是有效脚本的表，没有补全过
 * 就是 `run-launched` 的声明表。快照与冷回放的 before / after 都按它取邻居。
 */
export function phaseNamesFromEvents(events: readonly StoredEvent[]): string[] | undefined {
  let names: string[] | undefined;
  for (const { event } of events) {
    if (event.type === "run-launched" && names === undefined) names = event.phaseNames;
    if (event.type === "hole-filled") names = event.phaseNames;
  }
  return names;
}

export interface ProjectRunHolesInput {
  /** `readRunHoleEvents` 的返回（sequence 升序）。 */
  events: readonly StoredEvent[];
  /**
   * 引擎此刻的停驻表；`undefined` = 本进程没有活着的引擎（冷行、已结算、还没接上）。
   * **`waiting` 只在这张表里有它时成立**：进程亡故后没有 promise 在等，单靠事件会把一个没人问的
   * 留白报成在等（docs/execution-engine.md「The run snapshot」）。
   */
  openHoles: readonly OpenHole[] | undefined;
  /** 有效脚本的留白事实表（type / line 的来源）；缺席即这两项不出。 */
  holes: readonly CompiledHole[] | undefined;
  /** 此刻生效的阶段表（before / after 的来源）；缺席即这两项不出。 */
  phaseNames: readonly string[] | undefined;
}

/**
 * 快照与详情上的 `holes[]`（docs/execution-engine.md「The run snapshot」）：每一次到达一条，
 * 到达序；`waiting` 来自引擎的停驻表，`filled` 来自 `hole-filled` 事件。既不在等、又没补过的到达
 * （上一世停在留白处、进程死了）**不出现**——resume 会重新到达并记一条新的 `hole-reached`，
 * 那时它才又是一条在等的留白。零条时返回空数组，调用方据此让字段整个缺席。
 */
export function projectRunHoles(input: ProjectRunHolesInput): DynamicWorkflowRunHole[] {
  const waiting = new Set((input.openHoles ?? []).map((hole) => instanceKey(hole)));
  const filledBySite = new Map<string, HoleFilledEvent>();
  const reached: { event: HoleReachedEvent; at: number | undefined }[] = [];
  for (const stored of input.events) {
    if (stored.event.type === "hole-reached") {
      reached.push({ event: stored.event, at: stored.timeCreated });
    } else if (stored.event.type === "hole-filled") {
      filledBySite.set(stored.event.siteId, stored.event);
    }
  }
  const byId = new Map((input.holes ?? []).map((hole) => [hole.siteId, hole]));
  const out: DynamicWorkflowRunHole[] = [];
  for (const { event, at } of reached) {
    if (out.length >= SNAPSHOT_MAX_HOLES) break;
    const { siteId, ordinal } = event.instance;
    const compiled = byId.get(siteId);
    const filled = filledBySite.get(siteId);
    const isWaiting = waiting.has(instanceKey(event.instance));
    if (!isWaiting && filled === undefined) continue;
    out.push({
      siteId,
      ordinal,
      name: event.name,
      type: compiled?.type ?? UNKNOWN_HOLE_TYPE,
      ...(isWaiting
        ? { state: "waiting" as const, ...(at === undefined ? {} : { since: at }) }
        : {
            state: "filled" as const,
            filledAt: filled!.filledAt,
            ...(filled!.filledBy === undefined ? {} : { filledBy: filled!.filledBy }),
          }),
      ...(compiled === undefined ? {} : { line: compiled.line }),
      ...neighbourPhases(event.name, input.phaseNames),
    });
  }
  return out;
}

/**
 * 冷行（本进程没有条目）的留白事实表：事件里真有留白到达、行里有脚本时，对行里的（有效）脚本
 * 建一次站点表；否则 `undefined`。绝大多数 run 没有留白，这笔编译因此只在需要时付。脚本编不过
 * （老 facade 下写的行）同样回 `undefined`——这是读面，不该因为一次派生字段而抛。
 */
export function coldCompiledHoles(
  scriptText: string | undefined,
  events: readonly StoredEvent[],
): CompiledHole[] | undefined {
  if (scriptText === undefined) return undefined;
  if (!events.some((entry) => entry.event.type === "hole-reached")) return undefined;
  try {
    return compiledHolesOf(collectSites(createWorkflowProgram(scriptText)));
  } catch {
    return undefined;
  }
}

/**
 * 快照 / 详情两条读面共用的留白投影入口：热条目读它自己的事实表、阶段表与控制面上引擎的停驻表；
 * 冷行从事件与行里的脚本重建。条目在场却一处留白都没有（编译产物说的）时**零读**——那是绝大多数
 * run，`getTask` 被追踪器每秒轮询，不该为一个空字段付一次事件读。
 */
export function runHolesOf(
  runId: string,
  entry: RunRegistryEntry | undefined,
  journal: JournalStorePort,
  scriptText?: string,
): DynamicWorkflowRunHole[] {
  if (entry !== undefined && (entry.holes?.length ?? 0) === 0) return [];
  const events = readRunHoleEvents(journal, runId);
  if (events.length === 0) return [];
  const live = entry !== undefined && entry.terminal === undefined;
  return projectRunHoles({
    events,
    openHoles: live ? entry.control?.openHoles() : undefined,
    holes:
      entry?.holes ?? coldCompiledHoles(scriptText ?? journal.getRun(runId)?.scriptText, events),
    phaseNames: entry?.phaseNames ?? phaseNamesFromEvents(events),
  });
}

function instanceKey(ref: { siteId: string; ordinal: number }): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

/** 留白在阶段表里的前后邻居（留白按名字站在表里）；不在表里或没有邻居时各自缺席。 */
function neighbourPhases(
  name: string,
  phaseNames: readonly string[] | undefined,
): { before?: string; after?: string } {
  if (phaseNames === undefined) return {};
  const index = phaseNames.indexOf(name);
  if (index < 0) return {};
  const before = phaseNames[index - 1];
  const after = phaseNames[index + 1];
  return {
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * 补全被拒时的诊断映射（docs/dynamic-workflow/launch.md「The fill file」）。拼接把函数体插在
 * 脚本第 `insertedAtLine` 行起的 `insertedLines - 1` 行里（最后一行是右花括号），每行前面垫了
 * 调用缩进加两格。落在函数体行里的诊断标 `inFill`，行列改成函数体自己的坐标；落在右花括号那一行
 * 的算到调用那一行上；落在插入点之后的整体前移 `insertedLines`——拒绝时什么都没写，草稿仍是
 * 拼接前的脚本，行号得指向它。
 */
export function mapFillDiagnostics(input: {
  diagnostics: readonly CompileDiagnostic[];
  effectiveText: string;
  body: string;
  insertedAtLine: number;
  insertedLines: number;
}): DynamicWorkflowRunFillHoleDiagnostic[] {
  const { diagnostics, insertedAtLine, insertedLines } = input;
  const firstBodyLine = insertedAtLine;
  const lastBodyLine = insertedAtLine + insertedLines - 2;
  const closingLine = insertedAtLine + insertedLines - 1;
  const effectiveLines = input.effectiveText.split("\n");
  const bodyLines = input.body.replace(/\r?\n$/u, "").split(/\r?\n/u);
  return diagnostics.map((diagnostic) => {
    const base = { message: diagnostic.message, code: diagnostic.code };
    if (diagnostic.line >= firstBodyLine && diagnostic.line <= lastBodyLine) {
      const bodyLine = diagnostic.line - firstBodyLine + 1;
      const indent =
        leadingWhitespace(effectiveLines[diagnostic.line - 1] ?? "") -
        leadingWhitespace(bodyLines[bodyLine - 1] ?? "");
      return {
        ...base,
        inFill: true,
        line: bodyLine,
        column: Math.max(1, diagnostic.column - Math.max(0, indent)),
      };
    }
    if (diagnostic.line === closingLine) {
      return { ...base, inFill: false, line: insertedAtLine - 1, column: diagnostic.column };
    }
    if (diagnostic.line > closingLine) {
      return {
        ...base,
        inFill: false,
        line: diagnostic.line - insertedLines,
        column: diagnostic.column,
      };
    }
    return { ...base, inFill: false, line: diagnostic.line, column: diagnostic.column };
  });
}

/**
 * 补全的有效脚本里点名了本 run 绑定表之外的模型 → 9011，每个名字一条，落在它第一次出现的位置
 * （坐标是有效脚本的，交给 {@link mapFillDiagnostics} 换算）。
 *
 * 修复原因（MR !2837 评审 CR-01）：绑定表只在建 run 时对着目录解析一次、记在 `run-launched` 上，
 * 子代理建会话时按名字查它。补全此前只跑编译，函数体新写的 `model("accurate")` 照样被收下、留白
 * 被放行，直到那个子代理启动才以 WorkflowActorModelUnboundError 失败——而用户批准的启动窗里根本
 * 没有这个模型。补全的确认窗不列模型，所以函数体只能用表里已有的名字；要换模型走 AmendWorkflow。
 */
export function unboundFillModelDiagnostics(
  references: readonly ModelReference[],
  bindings: Readonly<Record<string, string>> | undefined,
): CompileDiagnostic[] {
  const bound = Object.entries(bindings ?? {});
  const available =
    bound.length === 0
      ? "this run was launched without naming any model"
      : `this run was launched with ${bound.map(([name, canonical]) => `"${name}" = ${canonical}`).join("; ")}`;
  const reported = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const reference of references) {
    if (bindings?.[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      message: `The model "${reference.name}" is not one the run can use: ${available}, and a fill can name only those. Use one of them, or drop \`model\` from the persona; to add a model, revise the run with AmendWorkflow.`,
    });
  }
  return diagnostics;
}

function leadingWhitespace(line: string): number {
  return /^[ \t]*/u.exec(line)?.[0].length ?? 0;
}
