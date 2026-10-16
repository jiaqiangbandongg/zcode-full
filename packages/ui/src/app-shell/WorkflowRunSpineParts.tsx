// ============================================================
// 侧栏脊线的零件
// ============================================================
// 从 WorkflowRunPhaseList.tsx 拆出（max-lines 400）：清单文件承载展开状态、问题归属与药丸接线，
// 本文件承载纯展示件——轨道段、接头行、灯、折叠节头上的头像串、轮次、子代理行的尾巴（计数与模型名）。

import { useId, useMemo, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowActorModelLabels } from "@/components/workflow-timeline/subagent-model-label.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import { StreamChevronsBox } from "@/components/workflow-timeline/WorkflowStreamChevrons.js";
import {
  SPINE_JOINT_PX,
  SPINE_TRACK_X,
  type SpineJoint,
  type SpineSection,
} from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 开口接头行的主轨朝行外伸出的长度（卡上的 TAIL）。 */
const SPINE_STUB_PX = 4;

/** 流轨的两半各在节边界前后让出这么多，缺口里站两枚朝下的 chevron。 */
const SPINE_STREAM_GAP_PX = 7;

/** 折叠节头上最多几枚头像；其余进 `+n`。 */
const CLUSTER_MAX = 3;

/**
 * 轨道段的一半。相邻两站之间的一段轨道拆成两截画：上一站从灯底到节底，下一站从节顶到灯顶——
 * 两截同一墨色，接在节的边界上。这样轨道随节的展开 / 折叠自己长短，不用量。
 *
 * 带里还有第三种：`full` 整节穿过（主轨经过分支站、分支轨经过别人的站），接头行里的主轨也是它。
 * 轨道 t > 0 的 x 用内联样式给（`21 + pitch·t`）——它是算出来的，Tailwind 生不出这个类。
 *
 * 行进段（`march`）是一条 1.5px 的**亮着的**轨道，不动：它说的是控制流已经走过的那条边，动作留给
 * 正在运行的灯。亮度沿着控制流的方向涨——`data-rail-position` 就是给样式表选渐变用的，两截都得带着
 * 它：`below`（上一节的下半截）从透明淡入到七成警示色，`above`（运行那一节的上半截）从七成涨到满，
 * 一直亮进灯里，`full` 是平的七成。
 */
export function SpineRail({
  ink,
  overhang,
  pitch,
  position,
  stream,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  /** 流轨的一半：在节边界让出 `SPINE_STREAM_GAP_PX`，不叠行进的光。 */
  stream?: true;
  track?: number;
  /** 轨距（`workflowRunSpine.ts`）；只有 track > 0 才读它。 */
  pitch: number;
  /** 开口接头行的主轨：向行外伸出 `SPINE_STUB_PX`——根在上、汇点在下。 */
  overhang?: "top" | "bottom";
}) {
  const x = SPINE_TRACK_X + pitch * track;
  const style: CSSProperties = {};
  // 流轨的墨在 chevron 上；它的两半始终是 1px 的平墨。
  const lit = ink === "march" && stream !== true;
  if (track > 0) style.left = lit ? x - 0.75 : x - 0.5;
  if (stream === true && position === "below") style.bottom = SPINE_STREAM_GAP_PX;
  if (stream === true && position === "above") {
    style.top = SPINE_STREAM_GAP_PX;
    style.height = 12 - SPINE_STREAM_GAP_PX;
  }
  if (overhang !== undefined) {
    style.top = overhang === "top" ? -SPINE_STUB_PX : 0;
    style.bottom = overhang === "bottom" ? -SPINE_STUB_PX : 0;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        lit ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        !lit && "bg-foreground-subtlest",
        lit && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-kind={stream === true ? "stream" : undefined}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * 一节里全部的竖轨（`workflowRunSpine.ts` 算好的），一口气画出来。流轨的下半截在节底边的正中
 * 放两枚朝下的 chevron（presentation.md「The spine」）；z-index 1，下一节的节头悬停底色压不住它。
 */
export function SpinePieces({ pitch, section }: { pitch: number; section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} pitch={pitch} {...rail} />
      ))}
      {section.rails.map((rail) =>
        rail.stream === true && rail.position === "below" ? (
          <StreamChevronsBox
            count={2}
            direction="down"
            ink={rail.ink}
            key={`stream:${rail.track}`}
            style={{ left: SPINE_TRACK_X + pitch * rail.track, top: "100%", zIndex: 1 }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * 接头行（presentation.md「The spine」）：分叉或汇合在两节**之间**占一行 16px。主轨从中直穿；每条
 * 分支沿同一根 y = 8 的母线离开（或回到）主轨——竖下、半径 min(6, pitch/2) 的一个转角、横到自己
 * 的列、再一个转角竖下到行底；只有一条分支时两个转角接成一个 S。汇合是分叉的镜像。
 *
 * 曲线一律先画底墨，行进的再沿同一条路径叠一条亮着的光（`MarchLight`）：从控制流来的那一头淡入、
 * 到灯那一头最亮，不动。渐变的两端就是画 `path` 的首尾两点；`id` 用 `useId()`，一张 SVG 里唯一。
 * 开口的行（没有前驱的分叉、没有汇合站的汇合）主轨不接上一节 / 下一节，而是朝行外伸出 4px 收成圆头：
 * 一个根、一个汇点（卡上的 TAIL / STUB）。整行是装饰（`aria-hidden`）：它说的事灯与节头已经说了。`joint` 缺席即这里没有接头，什么都不画。
 */
export function SpineJointRow({
  joint,
  kind,
  pitch,
}: {
  joint: SpineJoint | undefined;
  kind: "fork" | "merge";
  pitch: number;
}) {
  const lightBase = useId();
  if (joint === undefined) return null;
  const main = SPINE_TRACK_X - 0.5;
  const r = Math.min(6, pitch / 2);
  const bus = SPINE_JOINT_PX / 2;
  const curves = joint.branches.map((branch) => {
    const x = main + pitch * branch.track;
    const d =
      kind === "fork"
        ? `M${main},0 V${bus - r} Q${main},${bus} ${main + r},${bus} H${x - r} Q${x},${bus} ${x},${bus + r} V${SPINE_JOINT_PX}`
        : `M${x},0 V${bus - r} Q${x},${bus} ${x - r},${bus} H${main + r} Q${main},${bus} ${main},${bus + r} V${SPINE_JOINT_PX}`;
    const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
    const to = kind === "fork" ? { x, y: SPINE_JOINT_PX } : { x: main, y: SPINE_JOINT_PX };
    return { ...branch, d, from, to };
  });
  const width = main + pitch * Math.max(1, ...joint.branches.map((branch) => branch.track)) + 8;
  return (
    <div
      aria-hidden
      className="relative shrink-0"
      data-joint-kind={kind}
      data-joint-open={joint.open === true ? "true" : undefined}
      data-testid="workflow-run-spine-joint"
      style={{ height: SPINE_JOINT_PX }}
    >
      <SpineRail
        ink={joint.main}
        pitch={pitch}
        position="full"
        {...(joint.open === true ? { overhang: kind === "fork" ? "top" : "bottom" } : {})}
      />
      <svg
        className="absolute left-0 top-0 overflow-visible"
        height={SPINE_JOINT_PX}
        viewBox={`0 0 ${width} ${SPINE_JOINT_PX}`}
        width={width}
      >
        {curves.map((curve) => (
          <g
            data-curve-ink={curve.ink}
            data-curve-track={curve.track}
            data-testid={`workflow-run-spine-${kind}`}
            key={curve.track}
          >
            <path
              className="wf-ink"
              d={curve.d}
              fill="none"
              stroke="var(--color-foreground-subtlest)"
              strokeLinecap="round"
              strokeWidth={1}
            />
          </g>
        ))}
        {/* 光叠在全部底墨之上：几条分支共用母线，后画的底墨不能把前一条的光盖住。 */}
        {curves.map((curve) =>
          curve.ink === "march" ? (
            <g data-testid={`workflow-run-spine-${kind}-lit`} key={`lit:${curve.track}`}>
              <MarchLight
                d={curve.d}
                from={curve.from}
                id={`${lightBase}lit-${curve.track}`}
                to={curve.to}
              />
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/**
 * 轨道上的灯：空心 = 未到，绿 = 已过，红带环 = 失败，琥珀带搏动 = 正在运行。运行中的灯与卡上的灯
 * 同一条命（`wf-lamp-running`）：常亮的光晕加一下心跳；`motion-reduce` 时只剩光晕。
 */
export function SpineLamp({
  pitch,
  status,
  track = 0,
}: {
  status: StepRunStatus;
  track?: number;
  pitch: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full",
        STATUS_DOT[status],
        status === "pending" && "bg-background",
        status === "running" && "wf-lamp-running motion-reduce:animate-none",
      )}
      data-lamp={status}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + pitch * track }}
    />
  );
}

/** 折叠节头上的头像串：谁在这一站，一眼可见；子代理是按编号定色的瓦片脸，工作区是终端字形。 */
export function AvatarCluster({
  pills,
  nameOf,
}: {
  pills: readonly TimelinePill[];
  nameOf: (pill: TimelinePill) => string;
}) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, CLUSTER_MAX);
  const more = pills.length - shown.length;
  return (
    <span className="flex items-center gap-1" data-testid="workflow-run-phase-cluster">
      {shown.map((pill) => {
        const tinted = pill.laneClass === "agent";
        const color = tinted ? agentColor(pill.avatarIndex, nameOf(pill)) : undefined;
        return (
          <span
            className={cn(
              "contents",
              tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
            )}
            key={pill.key}
            style={color === undefined ? undefined : { ["--wf-avatar" as string]: color }}
            title={nameOf(pill)}
          >
            <LaneGlyph
              className="size-4 shrink-0"
              avatarIndex={pill.avatarIndex}
              laneClass={pill.laneClass}
              name={nameOf(pill)}
              status={pill.status}
            />
          </span>
        );
      })}
      {more > 0 ? (
        <span className="ml-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** 轮次：`⟳ n`，只在回边两端且至少跑过一轮时在场（与卡上同一条规则）。 */
export function Rounds({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  if (!station.onLoop || station.rounds === 0) return null;
  return (
    <span
      className="flex items-center gap-[3px]"
      data-testid="workflow-run-phase-rounds"
      title={intl.formatMessage(
        { id: "chat.toolCall.workflow.timeline.rounds" },
        { count: station.rounds },
      )}
    >
      <Repeat2Icon aria-hidden className="size-[11px]" />
      <span>{station.rounds}</span>
    </span>
  );
}

/**
 * 子代理行的尾巴：计数（「{n} 个任务 · {n} 次读取」），persona 点名了模型时再跟模型名
 * （presentation.md「The spine」）。模型名可以很长（自定义 provider 的「名字/模型」）：它与子代理名
 * 一起让位，计数不让。
 */
export function SpinePillTrailer({
  counts,
  modelName,
}: {
  counts: readonly string[];
  modelName: string | undefined;
}) {
  return (
    <>
      {counts.length === 0 ? null : (
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {counts.join(" · ")}
        </span>
      )}
      {modelName === undefined ? null : (
        <span
          className="min-w-0 max-w-[45%] truncate font-mono text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-agent-model"
        >
          {counts.length === 0 ? modelName : `· ${modelName}`}
        </span>
      )}
    </>
  );
}

/** {@link workflowActorModelLabels} 按 actors 表与语言记忆一次（脊线每次重渲染都要查）。 */
export function useWorkflowActorModelLabels(
  actors: readonly { siteId: string; ordinal: number; model?: string }[] | undefined,
  providerName: ((providerId: string) => string | undefined) | undefined,
): ReadonlyMap<string, { name: string; canonical: string }> {
  const { intl } = useZCodeIntl();
  return useMemo(
    () =>
      workflowActorModelLabels(actors, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(providerName === undefined ? {} : { providerName }),
      }),
    [actors, intl, providerName],
  );
}
