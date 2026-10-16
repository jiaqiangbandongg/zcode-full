import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { StreamSpec } from "./timeline-bands.js";

// 顺序规则的两件（`isCurrentPhase` / `stationStatus`）原在 timeline-model.ts；dwf-recursive 与
// dwf-pipeline-display 合并后那个文件到了 430 行（oxlint max-lines 上限 400），灯的规则于是都搬来这里。

/** `currentPhase` 与一站的关联，与 `phaseEntryFor` 同一条名字规则。 */
export function isCurrentPhase(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * 站的灯。成员节点先说话——running / failed 是硬事实；
 * 之后才轮到控制流：这一站是当前阶段且 run 还在跑，就是 running（第一个 ask 派发之前、最后
 * 一个 ask 结算之后下一个标记到来之前，控制流都在这一站）；一个节点都没观察到的站（零成员，
 * 或整站被跳过）只能靠进入记录点灯。`nodeStatus` 是折叠的结果，缺席（undefined）就是「没有
 * 节点」——折叠不会为控制流没走的站点造一个 pending。
 */
export function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // 当前阶段随 run 的终态收场：失败发生在这一站（不管它有没有节点）；cancelled 与节点的画法
  // 一致，同样是 failed。
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * 阶段的灯与流的墨（docs/dynamic-workflow/presentation.md「Station status」「Ink」）。
 *
 * 一个 **stage** = 有 `alongside` 伙伴或有流、且至少有一个成员 step 的站。stage 的 future 一开跑就先
 * 执行自己的 `phase()` 标记，所以「进入过」「是 currentPhase」对它什么都没说：触发它的那次 run 里
 * 五个标记 108ms 内全部跑完，还在等 channel 的站按「进入过、没有节点」画成了 done，最后一站（唯一
 * 的 currentPhase）一个节点没跑就替 run 背了停止的红灯。stage 的灯因此只看自己的节点，和喂它的站：
 *
 * 1. 没有节点：run 还活着就是 pending；结束了，`completed` 且进入过是 done，否则 pending；
 * 2. 否则是折叠值——但 run 还活着、喂它的某一站还**开着**时，done 仍是 running（还会有活进来）。
 *    一站开着 = run 活着，且它按自己的节点是 running / pending（没有节点也算 pending），或喂它的站开着；
 *    按不动点求，反馈环也会停。
 *
 * 不是 stage 的站、以及没有成员 step 的 stage（只有标记）照旧走顺序规则（`sequential`）。
 */
export function stageStatuses(input: {
  run: WorkflowRunState | undefined;
  /** 每一站成员 step 的折叠；缺席 = 没有节点。 */
  nodeStatuses: readonly (StepRunStatus | undefined)[];
  entered: readonly boolean[];
  /** 每一站有没有成员 step（只有标记的阶段没有）。 */
  hasMembers: readonly boolean[];
  /** 每一站的 `alongside`（下标，只有后来者报得出，这里对称地读）。 */
  alongside: readonly (readonly number[])[];
  streams: readonly StreamSpec[];
  /** 顺序规则给出的灯（非 stage 站原样用它）。 */
  sequential: readonly (StepRunStatus | undefined)[];
}): (StepRunStatus | undefined)[] {
  const { alongside, entered, hasMembers, nodeStatuses, run, sequential, streams } = input;
  if (run === undefined) return [...sequential];
  const parallel = new Set([
    ...streams.flatMap((stream) => [stream.from, stream.to]),
    ...alongside.flatMap((near, i) => (near.length > 0 ? [i, ...near] : [])),
  ]);
  const stage = nodeStatuses.map((_, i) => hasMembers[i] === true && parallel.has(i));
  const live = run.status === "running" || run.status === "pending";
  const feeders = nodeStatuses.map(() => [] as number[]);
  for (const stream of streams) feeders[stream.to]?.push(stream.from);

  const own = (i: number): StepRunStatus | undefined =>
    stage[i] ? (nodeStatuses[i] ?? "pending") : sequential[i];
  const open = nodeStatuses.map((_, i) => live && (own(i) === "running" || own(i) === "pending"));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < open.length; i += 1) {
      if (open[i] || !live || !feeders[i]!.some((f) => open[f])) continue;
      open[i] = true;
      changed = true;
    }
  }

  return nodeStatuses.map((status, i) => {
    if (!stage[i]) return sequential[i];
    if (status === undefined) {
      if (live) return "pending";
      return run.status === "completed" && entered[i] ? "done" : "pending";
    }
    if (status === "done" && live && feeders[i]!.some((f) => open[f])) return "running";
    return status;
  });
}

/** 载荷的 `phaseStreams` → 下标对：两端都得列出、不是自环、每个有序对只留一条。 */
export function phaseStreamIndexes(
  streams: readonly { from: string; to: string }[] | undefined,
  index: ReadonlyMap<string, number>,
): StreamSpec[] {
  const out: StreamSpec[] = [];
  const seen = new Set<string>();
  for (const stream of streams ?? []) {
    const from = index.get(stream.from);
    const to = index.get(stream.to);
    if (from === undefined || to === undefined || from === to || seen.has(`${from}>${to}`))
      continue;
    seen.add(`${from}>${to}`);
    out.push({ from, to });
  }
  return out;
}

/**
 * 一条流的墨：两端都在跑是 `march`（东西正在过），否则目标站观察到过节点是 `strong`（过去过），
 * 否则 `faint`。「观察到过节点」而不是 `visited`：stage 的进入记录在 run 一开始就有了。
 */
export function streamInk(
  from: { status: StepRunStatus | undefined },
  to: { status: StepRunStatus | undefined; fraction?: unknown },
): "faint" | "strong" | "march" {
  if (from.status === "running" && to.status === "running") return "march";
  return to.fraction === undefined ? "faint" : "strong";
}
