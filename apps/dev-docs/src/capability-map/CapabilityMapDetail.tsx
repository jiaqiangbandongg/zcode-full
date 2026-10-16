import type { ReactNode } from "react";
import { Focus, Network } from "lucide-react";
import {
  capabilityEdges,
  capabilityNodes,
  capabilityRelationNames,
  type CapabilityRelationType,
} from "@/data/productCapabilityMap.js";
import {
  capabilityCodeEstimateConfidenceNames,
  formatCapabilityCodeEstimateFull,
  getCapabilityGroupComplexity,
  groupById,
  nodeById,
  relationTypes,
  systemById,
  type CapabilitySelection,
  type EdgeScope,
} from "@/capability-map/capabilityMapTypes.js";

export function CapabilityMapDetail({
  edgeScope,
  enabledRelations,
  onSelectGroup,
  onSelectNode,
  selection,
}: {
  edgeScope: EdgeScope;
  enabledRelations: Set<CapabilityRelationType>;
  onSelectGroup: (groupId: string) => void;
  onSelectNode: (nodeId: string) => void;
  selection: CapabilitySelection;
}) {
  const filteredEdges = capabilityEdges.filter((edge) => {
    if (!enabledRelations.has(edge.type)) {
      return false;
    }
    return (
      edgeScope === "all" ||
      nodeById.get(edge.source)?.groupId !== nodeById.get(edge.target)?.groupId
    );
  });

  if (!selection) {
    return (
      <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
        <div className="flex items-center gap-2 text-brand">
          <Network className="size-4" />
          <span className="text-ui-sm font-medium">能力地图</span>
        </div>
        <h2 className="mt-2 text-ui-lg font-medium">选择一个群或节点</h2>
        <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          地图按 Renderer、Host、ZCode CLI
          三层运行时和底部工程基础设施组织。选择后保留当前视角并突出一阶关系，点击空白区域可重置。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {relationTypes.map((type) => (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-ui-sm text-foreground-subtle"
              key={type}
            >
              <i
                aria-hidden="true"
                className={`capability-relation-swatch capability-map-edge--${type}`}
              />
              {capabilityRelationNames[type]}
            </span>
          ))}
        </div>
      </aside>
    );
  }

  if (selection.kind === "group") {
    const group = groupById.get(selection.id);
    if (!group) {
      return null;
    }
    const nodes = capabilityNodes.filter((node) => node.groupId === group.id);
    const system = systemById.get(group.systemId);
    const complexity = getCapabilityGroupComplexity(group.id);
    return (
      <DetailShell
        description={group.description}
        kicker="能力群"
        title={group.name}
      >
        <DetailFact label="顶层区域" value={system?.name ?? "未分配"} />
        <DetailFact label="建议主要 owner" value={group.owner} />
        <DetailFact
          label="主责代码估算（Estimated Owned LOC）"
          value={formatCapabilityCodeEstimateFull(
            group.codeEstimate.productionLines,
          )}
        />
        <DetailFact
          label="估算置信度（Confidence）"
          value={
            capabilityCodeEstimateConfidenceNames[group.codeEstimate.confidence]
          }
        />
        <DetailFact label="能力节点" value={`${nodes.length} 个`} />
        <DetailFact
          label="跨群入度（Cross-group In-degree）"
          value={`${complexity.inDegree} 条`}
        />
        <DetailFact
          label="跨群出度（Cross-group Out-degree）"
          value={`${complexity.outDegree} 条`}
        />
        <div className="mt-4 grid gap-1.5">
          {nodes.map((node) => (
            <DetailButton
              key={node.id}
              label={node.label}
              metadata={node.authority}
              onClick={() => onSelectNode(node.id)}
            />
          ))}
        </div>
      </DetailShell>
    );
  }

  const node = nodeById.get(selection.id);
  if (!node) {
    return null;
  }
  const group = groupById.get(node.groupId);
  const system = group ? systemById.get(group.systemId) : undefined;
  const connections = filteredEdges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  );
  return (
    <DetailShell
      description={node.scope}
      kicker={
        <button
          className="inline-flex items-center gap-1 text-brand hover:underline"
          onClick={() => onSelectGroup(node.groupId)}
          type="button"
        >
          <Focus className="size-3.5" />
          {group?.name}
        </button>
      }
      title={node.label}
    >
      <DetailFact label="顶层区域" value={system?.name ?? "未分配"} />
      <DetailFact label="建议主要 owner" value={group?.owner ?? "未分配"} />
      <DetailFact label="权威状态 / 提交落点" value={node.authority} />
      <DetailFact label="一阶关系" value={`${connections.length} 条`} />
      <div className="mt-4 grid gap-1.5">
        {connections.map((edge) => {
          const outbound = edge.source === node.id;
          const otherNode = nodeById.get(outbound ? edge.target : edge.source);
          if (!otherNode) {
            return null;
          }
          return (
            <DetailButton
              key={edge.id}
              label={`${outbound ? "→" : "←"} ${otherNode.label}`}
              metadata={`${capabilityRelationNames[edge.type]} · ${edge.label}`}
              onClick={() => onSelectNode(otherNode.id)}
              relationType={edge.type}
            />
          );
        })}
      </div>
    </DetailShell>
  );
}

function DetailShell({
  children,
  description,
  kicker,
  title,
}: {
  children: ReactNode;
  description: string;
  kicker: ReactNode;
  title: string;
}) {
  return (
    <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
      <div className="text-ui-sm font-medium text-brand">{kicker}</div>
      <h2 className="mt-2 text-ui-lg font-medium text-foreground">{title}</h2>
      <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
        {description}
      </p>
      <div className="mt-4 grid gap-3">{children}</div>
    </aside>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-ui-sm text-foreground-subtlest">{label}</p>
      <p className="mt-1 text-ui-base text-foreground">{value}</p>
    </div>
  );
}

function DetailButton({
  label,
  metadata,
  onClick,
  relationType,
}: {
  label: string;
  metadata: string;
  onClick: () => void;
  relationType?: CapabilityRelationType;
}) {
  return (
    <button
      className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-2 rounded-md px-1 py-1.5 text-left hover:bg-menu-hover"
      onClick={onClick}
      type="button"
    >
      <i
        aria-hidden="true"
        className={`mt-1 size-2.5 rounded-full ${
          relationType
            ? `capability-relation-dot--${relationType}`
            : "bg-foreground-subtlest"
        }`}
      />
      <span className="min-w-0">
        <span className="block text-ui-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block break-words font-mono text-ui-xs text-foreground-subtlest">
          {metadata}
        </span>
      </span>
    </button>
  );
}
