import { memo, type CSSProperties } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import {
  formatCapabilityCodeEstimateCompact,
  formatCapabilityCodeEstimateFull,
  getCapabilityGroupComplexity,
  nodeById,
  type CapabilityFlowEdge,
  type CapabilityGroupFlowNode,
  type CapabilityItemFlowNode,
  type CapabilitySystemFlowNode,
} from "@/capability-map/capabilityMapTypes.js";
import {
  CAPABILITY_GROUP_HEADER_HEIGHT,
  CAPABILITY_SYSTEM_HEADER_HEIGHT,
} from "@/capability-map/capabilityMapGeometry.js";

const capabilitySystemHeaderStyle = {
  height: CAPABILITY_SYSTEM_HEADER_HEIGHT,
} satisfies CSSProperties;

const capabilityGroupHeaderStyle = {
  height: CAPABILITY_GROUP_HEADER_HEIGHT,
} satisfies CSSProperties;

function CapabilitySystemFlowNodeView({
  data,
}: NodeProps<CapabilitySystemFlowNode>) {
  return (
    <section
      className={`h-full w-full rounded-2xl border-2 border-dashed border-border bg-background-alt ${
        data.dimmed ? "opacity-20" : ""
      }`}
    >
      <div
        className="overflow-hidden border-b border-dashed border-border px-5 py-4"
        style={capabilitySystemHeaderStyle}
      >
        <h2 className="text-ui-lg font-medium text-foreground">
          {data.system.name}
        </h2>
        <p className="mt-1 max-w-3xl text-ui-sm text-foreground-subtle">
          {data.system.description}
        </p>
      </div>
    </section>
  );
}

function CapabilityGroupFlowNodeView({
  data,
}: NodeProps<CapabilityGroupFlowNode>) {
  const complexity = getCapabilityGroupComplexity(data.group.id);
  const fullCodeEstimate = formatCapabilityCodeEstimateFull(
    data.group.codeEstimate.productionLines,
  );
  return (
    <section
      className={`h-full w-full rounded-xl border bg-surface ${
        data.selected
          ? "border-brand"
          : "border-card-border hover:border-border-hover"
      } ${data.dimmed ? "opacity-20" : ""}`}
    >
      <div
        className="overflow-hidden border-b border-border px-4 py-3"
        style={capabilityGroupHeaderStyle}
      >
        <h3 className="text-ui-base font-medium text-foreground">
          {data.group.name}
        </h3>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <p
            className="min-w-0 truncate text-ui-xs text-foreground-subtlest"
            title={data.group.owner}
          >
            {data.group.owner}
          </p>
          <span
            aria-label={`主责代码估算：${fullCodeEstimate}；跨群入度：${complexity.inDegree}；跨群出度：${complexity.outDegree}`}
            className="shrink-0 rounded-full bg-tag px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle"
            title={`主责代码估算：${fullCodeEstimate}；跨群入度：${complexity.inDegree}；跨群出度：${complexity.outDegree}`}
          >
            {formatCapabilityCodeEstimateCompact(
              data.group.codeEstimate.productionLines,
            )}{" "}
            · 入{complexity.inDegree} · 出{complexity.outDegree}
          </span>
        </div>
      </div>
    </section>
  );
}

function CapabilityItemFlowNodeView({
  data,
}: NodeProps<CapabilityItemFlowNode>) {
  return (
    <article
      className={`flex h-full w-full items-center rounded-lg border bg-card px-3 ${
        data.selected
          ? "border-brand bg-card-selected"
          : data.searchMatch
            ? "border-brand"
            : "border-card-border hover:border-border-hover hover:bg-card-selected"
      } ${data.dimmed ? "opacity-20" : ""}`}
    >
      <Handle
        className="capability-map-handle"
        id="target"
        position={Position.Left}
        type="target"
      />
      <span className="line-clamp-2 text-ui-sm font-medium leading-4 text-foreground">
        {data.capability.label}
      </span>
      <Handle
        className="capability-map-handle"
        id="source"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

const CapabilityGroupNode = memo(CapabilityGroupFlowNodeView);
const CapabilityItemNode = memo(CapabilityItemFlowNodeView);
const CapabilitySystemNode = memo(CapabilitySystemFlowNodeView);

export const capabilityMapNodeTypes = {
  "capability-system": CapabilitySystemNode,
  "capability-group": CapabilityGroupNode,
  "capability-item": CapabilityItemNode,
};

function moveToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
  distance: number,
) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0 || length <= distance) {
    return to;
  }
  const ratio = distance / length;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

function roundedOrthogonalPath(points: { x: number; y: number }[]) {
  const firstPoint = points[0];
  if (!firstPoint) {
    return "";
  }
  let path = `M ${firstPoint.x} ${firstPoint.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!previous || !current || !next) {
      continue;
    }
    const cornerStart = moveToward(current, previous, 10);
    const cornerEnd = moveToward(current, next, 10);
    path += ` L ${cornerStart.x} ${cornerStart.y}`;
    path += ` Q ${current.x} ${current.y} ${cornerEnd.x} ${cornerEnd.y}`;
  }
  const lastPoint = points.at(-1);
  return lastPoint ? `${path} L ${lastPoint.x} ${lastPoint.y}` : path;
}

function CapabilityMapEdge({
  data,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<CapabilityFlowEdge>) {
  const fallback = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const path = data?.route
    ? roundedOrthogonalPath(data.route.points)
    : fallback[0];
  const labelPosition = data?.route
    ? data.route.labelPosition
    : { x: fallback[1], y: fallback[2] };
  const relationType = data?.capability.type ?? "state";
  const intraGroup =
    data &&
    nodeById.get(data.capability.source)?.groupId ===
      nodeById.get(data.capability.target)?.groupId;

  return (
    <>
      <BaseEdge
        className={`capability-map-edge capability-map-edge--${relationType} ${
          data?.highlighted ? "is-highlighted" : ""
        } ${data?.dimmed ? "is-dimmed" : ""} ${intraGroup ? "is-intra-group" : ""}`}
        markerEnd={markerEnd}
        path={path}
      />
      {data?.showLabel ? (
        <EdgeLabelRenderer>
          {/* Bug 原因：节点自身使用 z-index，标签未声明层级时会被相邻节点盖住。 */}
          <span
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-1.5 py-0.5 text-ui-xs text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px,${labelPosition.y - 12}px)`,
            }}
          >
            {data.capability.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const capabilityMapEdgeTypes = {
  "capability-edge": memo(CapabilityMapEdge),
};
