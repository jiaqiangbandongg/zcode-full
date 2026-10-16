// ============================================================
// workflowRuns 归约的留白分支：`hole-reached` / `hole-filled`，以及阶段表上的留白下标
// ============================================================
// 从 workflow-runs-reducer.ts 拆出（max-lines 门，与 phases / started 同一先例）。
// 契约见 docs/dynamic-workflow/presentation.md「Holes on the timeline」的「The model」一段与
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunHole,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { boundedPhaseName, nonEmptyString } from "./workflow-runs-entries.js";

/**
 * 留白的站点 id：`hole#` 加 8 位十六进制，键是留白的**名字**，与嵌套深度无关（CLI 的
 * analysis/hole-id.ts 铸造；apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Sites」）。
 * id 里不再写嵌套关系：一个留白在哪个留白里面，看它自己的阶段 / 站上的 `fill`。
 */
export const WORKFLOW_HOLE_SITE_ID_PATTERN = /^hole#[0-9a-f]{8}$/u;

function readEpoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * `run-launched.holes` / `hole-filled.holes` 的搬运：下标指向**被接受的**那张 `phaseNames`，所以
 * 越界、非整数、重复一律丢——越界的下标会让侧栏把一盏虚线灯画到一个不存在的站上。一项都不剩时
 * 返回 `undefined`：键不建。
 */
export function readPhaseHoles(raw: unknown, count: number): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value >= count || out.includes(value)) continue;
    out.push(value);
    if (out.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return out.length === 0 ? undefined : out;
}

/**
 * 载荷上的声明阶段表（`run-launched` 与 `hole-filled` 同形）：按声明序、裁到与 `phases` 同一对界。
 * 空表返回 `undefined`，调用方据此不动已有的表。
 */
export function readPhaseNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    names.push(name);
    if (names.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return names.length === 0 ? undefined : names;
}

/**
 * `hole-reached`：run 走到一个开着的留白，那条分支停驻。按**站点 id** upsert——循环里同一站点会停驻
 * 第二个 ordinal，表里只留最新的；重放同一条事件逐字节无变化（顶层的结构比对随即返回 null）。
 * `name` 是这条记录存在的全部理由（每个面都按名字标它），缺席只抬水位。触界与 nodes / actors 同族：
 * 拒绝新条目、已有条目照常更新、置 truncated。
 */
/** 提示语截到上限：超长时留 499 字加 `…`，总长仍是 500。 */
function boundedHolePrompt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const max = WORKFLOW_RUNS_LIMITS.maxHolePromptLength;
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

export function reduceHoleReached(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const instance = payload.instance;
  if (typeof instance !== "object" || instance === null) return run;
  const siteId = nonEmptyString((instance as Record<string, unknown>).siteId);
  const ordinalRaw = (instance as Record<string, unknown>).ordinal;
  const ordinal = typeof ordinalRaw === "number" && Number.isInteger(ordinalRaw) ? ordinalRaw : 0;
  const name = boundedPhaseName(nonEmptyString(payload.name));
  if (siteId === undefined || name === undefined) return run;
  const type = nonEmptyString(payload.type)?.slice(0, WORKFLOW_RUNS_LIMITS.maxHoleTypeLength);
  const prompt = boundedHolePrompt(nonEmptyString(payload.prompt));
  // 到达时刻只能由事件携带（本模块无时钟）；两个键名都认：`reachedAt` 是通知载荷的词，`since` 是投影的词。
  const since = readEpoch(payload.reachedAt) ?? readEpoch(payload.since);
  const entry: WorkflowRunHole = {
    siteId,
    ordinal,
    name,
    ...(type === undefined ? {} : { type }),
    ...(prompt === undefined ? {} : { prompt }),
    state: "waiting",
    ...(since === undefined ? {} : { since }),
  };
  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // 已有记录（含补全过又被重新到达的——那是 resume 重放到一个还没补的站点）：换成 waiting，
    // 类型缺席时沿用记过的那个。
    const previous = existing[index]!;
    const merged: WorkflowRunHole = {
      ...entry,
      ...(entry.type === undefined && previous.type !== undefined ? { type: previous.type } : {}),
      ...(entry.prompt === undefined && previous.prompt !== undefined
        ? { prompt: previous.prompt }
        : {}),
    };
    return { ...run, holes: existing.map((hole, i) => (i === index ? merged : hole)) };
  }
  if (existing.length >= WORKFLOW_RUNS_LIMITS.maxHoles) return { ...run, truncated: true };
  return { ...run, holes: [...existing, entry] };
}

/**
 * `hole-filled`：主代理的补全接进了 run。三件事一步做完——那条记录翻成 filled、阶段表换成补全后的
 * 声明表（超集：留白的体在留白的位置展开）、留白下标表整张换新。「同时在跑」表按插入位置右移：
 * 补全只在留白那一站之后插入 k 站，旧表里 > h 的下标一律 +k；表的形状对不上（不是这种插入）就丢掉，
 * 宁可侧栏少画双线段，也不把它连到错的站上。
 */
export function reduceHoleFilled(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const siteId = nonEmptyString(payload.siteId);
  if (siteId === undefined) return run;
  const filledAt = readEpoch(payload.filledAt);
  const filledBy = nonEmptyString(payload.filledBy)?.slice(0, 128);
  let next: WorkflowRunState = run;

  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // 提示语只为等待体而存在：补全后丢掉，已结算的 run 状态不背着它。
    const { prompt: _prompt, ...reached } = existing[index]!;
    void _prompt;
    const filled: WorkflowRunHole = {
      ...reached,
      state: "filled",
      ...(filledAt === undefined ? {} : { filledAt }),
      ...(filledBy === undefined ? {} : { filledBy }),
    };
    next = { ...next, holes: existing.map((hole, i) => (i === index ? filled : hole)) };
  }

  const phaseNames = readPhaseNames(payload.phaseNames);
  if (phaseNames === undefined) return next;
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  const phaseAlongside = shiftPhaseAlongside(run, phaseNames);
  const { phaseAlongside: _stale, phaseHoles: _staleHoles, ...rest } = next;
  void [_stale, _staleHoles];
  return {
    ...rest,
    phaseNames,
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/** 旧表 + 「留白位置之后插入 k 站」 → 新表上的「同时在跑」下标；形状对不上返回 undefined。 */
function shiftPhaseAlongside(
  run: WorkflowRunState,
  names: readonly string[],
): number[][] | undefined {
  const old = run.phaseNames;
  const alongside = run.phaseAlongside;
  if (old === undefined || alongside === undefined) return undefined;
  const inserted = names.length - old.length;
  if (inserted < 0) return undefined;
  // 找插入点 h：前缀 old[0..h] 与后缀 old[h+1..] 都逐字相同。
  let h = -1;
  for (let i = 0; i < old.length; i += 1) {
    if (old[i] !== names[i]) break;
    h = i;
  }
  if (h < 0) return undefined;
  for (let i = h + 1; i < old.length; i += 1) {
    if (old[i] !== names[i + inserted]) return undefined;
  }
  const shift = (i: number): number => (i <= h ? i : i + inserted);
  const out: number[][] = [];
  for (let i = 0; i < names.length; i += 1) {
    const source = i <= h ? i : i - inserted;
    const entry = i > h && i <= h + inserted ? [] : (alongside[source] ?? []);
    out.push(entry.map(shift));
  }
  return out.some((entry) => entry.length > 0) ? out : undefined;
}

/**
 * 剥掉 waiting 记录（新的一世 / 终态）：真相是进程内的停驻 deferred，与 pendingQuestions 同一条理由——
 * 一个已停的 run 没有人在等补全；resume 重跑到那个站点会再发一条 `hole-reached`。filled 记录跨世保留：
 * 那是接进 run 的代码，不是残影。一条不剩时整个键摘掉。
 */
export function withoutWaitingHoles(run: WorkflowRunState): WorkflowRunState {
  if (run.holes === undefined) return run;
  const kept = run.holes.filter((hole) => hole.state === "filled");
  if (kept.length === run.holes.length) return run;
  const { holes: _dropped, ...rest } = run;
  void _dropped;
  return kept.length === 0 ? rest : { ...rest, holes: kept };
}
