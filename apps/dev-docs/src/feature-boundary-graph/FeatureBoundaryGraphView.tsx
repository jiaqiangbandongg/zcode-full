/* eslint-disable max-lines -- 图谱节点、关系筛选和详情面板需要共享同一套交互状态。 */
import "@xyflow/react/dist/style.css";
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Filter, Network, RotateCcw, Search } from "lucide-react";
import graph from "virtual:zcode-feature-boundary-graph";
import {
  featureBoundaryNodeKindLabels,
  getFeatureBoundaryGraphStats,
  type FeatureBoundaryEdge,
  type FeatureBoundaryGraph,
  type FeatureBoundaryNode,
  type FeatureBoundaryNodeKind,
  type FeatureBoundaryRelationRank,
} from "@/data/featureBoundaryGraph.js";
import {
  FEATURE_BOUNDARY_NODE_HEIGHT,
  FEATURE_BOUNDARY_NODE_WIDTH,
  featureBoundaryGraphLayoutPromise,
  type FeatureBoundaryGraphLayout,
} from "@/feature-boundary-graph/featureBoundaryGraphLayout.js";

type FeatureBoundaryFlowNodeData = {
  node: FeatureBoundaryNode;
  selected: boolean;
  dimmed: boolean;
  searchMatch: boolean;
};

type FeatureBoundaryFlowNode = Node<FeatureBoundaryFlowNodeData, "feature-boundary-node">;

type FeatureBoundaryFlowEdgeData = {
  edge: FeatureBoundaryEdge;
  highlighted: boolean;
  dimmed: boolean;
  showLabel: boolean;
};

type FeatureBoundaryFlowEdge = Edge<FeatureBoundaryFlowEdgeData, "feature-boundary-edge">;

const rankOptions: Array<[FeatureBoundaryRelationRank | "all", string]> = [
  ["all", "全部关系"],
  ["must-inspect", "必须检查"],
  ["should-inspect", "建议检查"],
  ["conditional", "条件关系"],
  ["invariant-only", "仅不变量"],
  ["evidence-only", "仅证据"],
];

const graphStats = getFeatureBoundaryGraphStats(graph);
const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));

function useFeatureBoundaryGraphLayout() {
  const [layout, setLayout] = useState<FeatureBoundaryGraphLayout | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void featureBoundaryGraphLayoutPromise
      .then((nextLayout) => {
        if (active) {
          setLayout(nextLayout);
        }
      })
      .catch((layoutError: unknown) => {
        if (active) {
          setError(layoutError instanceof Error ? layoutError.message : String(layoutError));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return { error, layout };
}

function getFeatureBoundaryKindClass(kind: FeatureBoundaryNodeKind) {
  return `feature-boundary-node--${kind}`;
}

function FeatureBoundaryNodeView({ data }: NodeProps<FeatureBoundaryFlowNode>) {
  const { node, searchMatch, selected, dimmed } = data;
  return (
    <article
      aria-label={`${node.label}，${featureBoundaryNodeKindLabels[node.kind]}`}
      className={`feature-boundary-node ${getFeatureBoundaryKindClass(node.kind)} ${
        selected ? "is-selected" : ""
      } ${searchMatch ? "is-search-match" : ""} ${dimmed ? "is-dimmed" : ""}`}
    >
      <Handle
        className="feature-boundary-handle"
        id="target"
        position={Position.Left}
        type="target"
      />
      <span className="feature-boundary-node-kind">{featureBoundaryNodeKindLabels[node.kind]}</span>
      <span className="feature-boundary-node-label" title={node.label}>
        {node.label}
      </span>
      <Handle
        className="feature-boundary-handle"
        id="source"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

function FeatureBoundaryEdgeView({
  data,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<FeatureBoundaryFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
  });
  return (
    <>
      <BaseEdge
        className={`feature-boundary-edge ${
          data?.highlighted ? "is-highlighted" : ""
        } ${data?.dimmed ? "is-dimmed" : ""}`}
        markerEnd={markerEnd}
        path={path}
      />
      {data?.showLabel ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY - 12}px)`,
            }}
          >
            {data.edge.type}
            {data.edge.rank ? ` · ${data.edge.rank}` : ""}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const featureBoundaryNodeTypes = {
  "feature-boundary-node": FeatureBoundaryNodeView,
};

const featureBoundaryEdgeTypes = {
  "feature-boundary-edge": FeatureBoundaryEdgeView,
};

function FeatureBoundaryGraphCanvas() {
  const { fitView } = useReactFlow<FeatureBoundaryFlowNode, FeatureBoundaryFlowEdge>();
  const { error, layout } = useFeatureBoundaryGraphLayout();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [rankFilter, setRankFilter] = useState<FeatureBoundaryRelationRank | "all">("all");
  const [selection, setSelection] = useState<string | null>(null);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();

  const matchingNodeIds = useMemo(() => {
    if (!normalizedQuery) {
      return new Set<string>();
    }
    return new Set(
      graph.nodes
        .filter((node) =>
          [node.id, node.label, ...node.aliases]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
        .map((node) => node.id),
    );
  }, [normalizedQuery]);

  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => rankFilter === "all" || edge.rank === rankFilter),
    [rankFilter],
  );

  const connectedNodeIds = useMemo(() => {
    if (!selection) {
      return new Set<string>();
    }
    const ids = new Set([selection]);
    for (const edge of visibleEdges) {
      if (edge.from === selection) {
        ids.add(edge.to);
      }
      if (edge.to === selection) {
        ids.add(edge.from);
      }
    }
    return ids;
  }, [selection, visibleEdges]);

  const flowNodes = useMemo<FeatureBoundaryFlowNode[]>(() => {
    if (!layout) {
      return [];
    }
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]));
    return graph.nodes.flatMap((node) => {
      const position = positions.get(node.id);
      if (!position) {
        return [];
      }
      const searchMatch = normalizedQuery ? matchingNodeIds.has(node.id) : false;
      return [
        {
          id: node.id,
          type: "feature-boundary-node",
          position,
          style: {
            width: FEATURE_BOUNDARY_NODE_WIDTH,
            height: FEATURE_BOUNDARY_NODE_HEIGHT,
          },
          data: {
            node,
            selected: selection === node.id,
            searchMatch,
            dimmed:
              (Boolean(selection) && !connectedNodeIds.has(node.id)) ||
              (Boolean(normalizedQuery) && !searchMatch),
          },
          draggable: false,
          selectable: true,
        },
      ];
    });
  }, [connectedNodeIds, layout, matchingNodeIds, normalizedQuery, selection]);

  const flowEdges = useMemo<FeatureBoundaryFlowEdge[]>(
    () =>
      visibleEdges.map((edge, index) => {
        const edgeId = edge.id ?? `edge-${index}`;
        const highlighted =
          Boolean(selection) && (edge.from === selection || edge.to === selection);
        return {
          id: edgeId,
          type: "feature-boundary-edge",
          source: edge.from,
          sourceHandle: "source",
          target: edge.to,
          targetHandle: "target",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--color-foreground-subtlest)",
            height: highlighted ? 16 : 12,
            width: highlighted ? 16 : 12,
          },
          data: {
            edge,
            highlighted,
            dimmed: Boolean(selection) && !highlighted,
            showLabel: highlighted,
          },
          selectable: false,
        };
      }),
    [selection, visibleEdges],
  );

  useEffect(() => {
    if (!layout) {
      return;
    }
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.82, padding: 0.08 });
    });
  }, [fitView, layout]);

  const clear = useCallback(() => {
    setQuery("");
    setRankFilter("all");
    setSelection(null);
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.82, padding: 0.08 });
    });
  }, [fitView]);

  if (error) {
    return (
      <main className="p-4">
        <div className="rounded-lg border border-warning/35 bg-card p-4 text-ui-base text-foreground">
          Feature boundary 图谱布局失败：{error}
        </div>
      </main>
    );
  }

  return (
    <main className="grid gap-4 px-4 py-4">
      <FeatureBoundaryToolbar
        matchingCount={normalizedQuery ? matchingNodeIds.size : graph.nodes.length}
        onQueryChange={setQuery}
        onRankFilterChange={setRankFilter}
        onReset={clear}
        query={query}
        rankFilter={rankFilter}
      />
      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="feature-boundary-graph-canvas min-w-0 overflow-hidden rounded-lg border border-card-border bg-card">
          {layout ? (
            <ReactFlow<FeatureBoundaryFlowNode, FeatureBoundaryFlowEdge>
              defaultEdgeOptions={{ type: "feature-boundary-edge" }}
              edges={flowEdges}
              edgeTypes={featureBoundaryEdgeTypes}
              fitView
              fitViewOptions={{ maxZoom: 0.82, padding: 0.08 }}
              maxZoom={2.4}
              minZoom={0.04}
              nodeTypes={featureBoundaryNodeTypes}
              nodes={flowNodes}
              nodesConnectable={false}
              nodesDraggable={false}
              onlyRenderVisibleElements
              onNodeClick={(_event, node) => setSelection(node.id)}
              onPaneClick={() => setSelection(null)}
              panOnDrag
              panOnScroll={false}
              proOptions={{ hideAttribution: true }}
              zoomOnScroll
            >
              <Background color="var(--color-border)" gap={24} size={1} />
              <Controls fitViewOptions={{ maxZoom: 0.82, padding: 0.08 }} showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="grid h-full min-h-[720px] place-items-center text-ui-base text-foreground-subtle">
              正在计算 feature boundary 布局…
            </div>
          )}
        </div>
        <FeatureBoundaryDetail
          graph={graph}
          rankFilter={rankFilter}
          selection={selection}
          onSelectNode={setSelection}
        />
      </section>
    </main>
  );
}

function FeatureBoundaryToolbar({
  matchingCount,
  onQueryChange,
  onRankFilterChange,
  onReset,
  query,
  rankFilter,
}: {
  matchingCount: number;
  onQueryChange: (query: string) => void;
  onRankFilterChange: (rank: FeatureBoundaryRelationRank | "all") => void;
  onReset: () => void;
  query: string;
  rankFilter: FeatureBoundaryRelationRank | "all";
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
        <label className="relative min-w-0 flex-1">
          <span className="mb-1 block text-ui-sm font-medium text-foreground-subtle">查找节点</span>
          <Search className="pointer-events-none absolute bottom-2 left-2.5 size-4 text-foreground-subtlest" />
          <input
            className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-mobile-input-safe text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused md:text-ui-base"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="例如：模型选择、workspace identity、MCP"
            type="search"
            value={query}
          />
          <span className="mt-1 block text-ui-xs text-foreground-subtlest">
            {matchingCount} 个匹配节点 · {graphStats.nodeCount} 个节点 · {graphStats.edgeCount} 条边
          </span>
        </label>
        <label className="min-w-48">
          <span className="mb-1 flex items-center gap-1 text-ui-sm font-medium text-foreground-subtle">
            <Filter className="size-3.5" />
            关系等级
          </span>
          <select
            className="h-8 w-full rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground outline-none focus:border-input-border-focused focus:bg-input-focused"
            onChange={(event) =>
              onRankFilterChange(event.target.value as FeatureBoundaryRelationRank | "all")
            }
            value={rankFilter}
          >
            {rankOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-ui-sm text-foreground hover:bg-surface-hover"
          onClick={onReset}
          type="button"
        >
          <RotateCcw className="size-3.5" />
          重置
        </button>
      </div>
    </section>
  );
}

function FeatureBoundaryDetail({
  graph: currentGraph,
  onSelectNode,
  rankFilter,
  selection,
}: {
  graph: FeatureBoundaryGraph;
  onSelectNode: (nodeId: string | null) => void;
  rankFilter: FeatureBoundaryRelationRank | "all";
  selection: string | null;
}) {
  if (!selection) {
    return (
      <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
        <div className="flex items-center gap-2 text-brand">
          <Network className="size-4" />
          <span className="text-ui-sm font-medium">Feature boundary graph</span>
        </div>
        <h2 className="mt-2 text-ui-lg font-medium">选择一个节点</h2>
        <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          图谱来自 feature-boundary-planner 的 YAML。点击节点突出一阶关系，滚轮缩放，拖拽平移。
        </p>
        <div className="mt-4 grid gap-2 border-t border-border pt-3 text-ui-sm">
          <DetailFact label="声明节点" value={`${graphStats.nodeCount} 个`} />
          <DetailFact label="语义边" value={`${graphStats.edgeCount} 条`} />
          <DetailFact label="未声明端点" value={`${graphStats.unresolvedEndpointCount} 个`} />
          <DetailFact
            label="当前关系筛选"
            value={rankOptions.find(([value]) => value === rankFilter)?.[1] ?? "全部关系"}
          />
        </div>
      </aside>
    );
  }

  const node = graphNodeById.get(selection);
  if (!node) {
    return null;
  }
  const directEdges = currentGraph.edges.filter(
    (edge) => edge.from === selection || edge.to === selection,
  );
  const renderList = (items: string[], emptyLabel = "—") =>
    items.length ? (
      <ul className="mt-1 grid gap-1 pl-4 text-ui-sm text-foreground-subtle">
        {items.map((item) => (
          <li className="break-words" key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-1 text-ui-sm text-foreground-subtlest">{emptyLabel}</p>
    );

  return (
    <aside
      aria-live="polite"
      className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20"
    >
      <div className="text-ui-sm font-medium text-brand">
        {featureBoundaryNodeKindLabels[node.kind]}
      </div>
      <h2 className="mt-2 text-ui-lg font-medium text-foreground">{node.label}</h2>
      <p className="mt-1 break-words font-mono text-ui-xs text-foreground-subtlest">{node.id}</p>
      <p className="mt-2 text-ui-sm text-foreground-subtle">{directEdges.length} 条直接关系</p>
      <div className="mt-4 grid gap-3">
        <DetailFact label="别名" value={node.aliases.length ? node.aliases.join("、") : "—"} />
        <DetailBlock label="出边">
          <RelationList
            edges={directEdges.filter((edge) => edge.from === selection)}
            onSelectNode={onSelectNode}
            direction="out"
          />
        </DetailBlock>
        <DetailBlock label="入边">
          <RelationList
            edges={directEdges.filter((edge) => edge.to === selection)}
            onSelectNode={onSelectNode}
            direction="in"
          />
        </DetailBlock>
        <DetailBlock label="文档">{renderList(node.docs)}</DetailBlock>
        <DetailBlock label="代码种子">{renderList(node.codeSeeds)}</DetailBlock>
        <DetailBlock label="不变量">
          {node.invariants.length ? (
            <ul className="mt-1 grid gap-1 pl-4 text-ui-sm text-foreground-subtle">
              {node.invariants.map((invariant) => (
                <li className="break-words" key={invariant}>
                  {invariant}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-ui-sm text-foreground-subtlest">—</p>
          )}
        </DetailBlock>
      </div>
    </aside>
  );
}

function RelationList({
  direction,
  edges,
  onSelectNode,
}: {
  direction: "in" | "out";
  edges: FeatureBoundaryEdge[];
  onSelectNode: (nodeId: string) => void;
}) {
  if (!edges.length) {
    return <p className="mt-1 text-ui-sm text-foreground-subtlest">—</p>;
  }
  return (
    <div className="mt-1 grid gap-1">
      {edges.map((edge, index) => {
        const otherId = direction === "out" ? edge.to : edge.from;
        const otherNode = graphNodeById.get(otherId);
        return (
          <button
            className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-2 rounded-md px-1 py-1.5 text-left hover:bg-menu-hover"
            key={edge.id ?? `${edge.from}-${edge.to}-${edge.type}-${index}`}
            onClick={() => onSelectNode(otherId)}
            type="button"
          >
            <i
              aria-hidden="true"
              className={`mt-1 size-2.5 rounded-full ${
                edge.rank === "must-inspect"
                  ? "bg-brand"
                  : edge.rank === "evidence-only"
                    ? "bg-foreground-subtlest"
                    : "bg-warning"
              }`}
            />
            <span className="min-w-0">
              <span className="block break-words text-ui-sm font-medium text-foreground">
                {direction === "out" ? "→" : "←"} {otherNode?.label ?? otherId}
              </span>
              <span className="mt-0.5 block break-words font-mono text-ui-xs text-foreground-subtlest">
                {edge.type}
                {edge.rank ? ` · ${edge.rank}` : ""}
              </span>
              {edge.condition ? (
                <span className="mt-0.5 block break-words text-ui-xs text-foreground-subtlest">
                  {edge.condition}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DetailBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="border-t border-border pt-3">
      <h3 className="text-ui-sm font-medium text-foreground">{label}</h3>
      {children}
    </section>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-ui-xs text-foreground-subtlest">{label}</p>
      <p className="mt-1 break-words text-ui-sm text-foreground">{value}</p>
    </div>
  );
}

export default function FeatureBoundaryGraphView() {
  return (
    <ReactFlowProvider>
      <FeatureBoundaryGraphCanvas />
    </ReactFlowProvider>
  );
}
