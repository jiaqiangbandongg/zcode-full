import type { ActorEdge, ActorGraph, ActorNode } from "./actor-graph.js";
import { WORKSPACE_LANE, type CausalityGraph, type Lane, type Step } from "./causality-graph.js";
import {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowNode,
} from "./flow-graph.js";
import type { Handoff, HandoffGraph, HandoffParticipant } from "./handoff-graph.js";
import type { ActorSite, SiteEdge, SiteGraph, SiteNode } from "./types.js";

/**
 * Pure mermaid emitters for the site graph and its derived actor graph. String
 * builders over the graph types only (same purity rule as actor-graph.ts); the
 * `pnpm charts` task renders these to `charts/` for live viewing.
 *
 * Two mermaid quirks the whole module exists to tame:
 *  - node ids may not contain `#`/`-`, so ids are sanitized (`ask#1` -> `ask_1`)
 *    while the ORIGINAL id is kept in the human-readable label;
 *  - label text is wrapped in double quotes with `"` rewritten to the `#quot;`
 *    entity, and backticks/newlines from user-derived text (agent names, glob
 *    patterns) stripped, so arbitrary script text cannot break the diagram syntax.
 */

/** Mermaid node id: strip everything but word characters (`ask#1` -> `ask_1`). */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Escape user-derived label text: drop backticks/newlines, entity-encode quotes. */
function escapeLabel(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "#quot;");
}

/** Wrap already-escaped label content in the double quotes mermaid needs. */
function quote(content: string): string {
  return `"${content}"`;
}

/** Emit a {@link SiteGraph} as a mermaid `flowchart TD`. Deterministic node/edge order. */
export function siteGraphToMermaid(graph: SiteGraph): string {
  const lines: string[] = ["flowchart TD"];

  // Lane membership: an ask whose actor set is exactly one actor renders inside that
  // actor's subgraph; multi-actor (may) and empty-actor asks stay top-level.
  const laneAsks = new Map<string, SiteNode[]>();
  const laned = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === "ask" && node.actors !== undefined && node.actors.length === 1) {
      const actorId = node.actors[0] as string;
      const list = laneAsks.get(actorId) ?? [];
      list.push(node);
      laneAsks.set(actorId, list);
      laned.add(node.id);
    }
  }

  // 1. Lane subgraphs, in actor source order; omit actors with no lane asks.
  for (const actor of graph.actors) {
    const asks = laneAsks.get(actor.id);
    if (asks === undefined || asks.length === 0) continue;
    lines.push(`  subgraph ${safeId(actor.id)}[${quote(laneTitle(actor))}]`);
    for (const ask of asks) lines.push(`    ${siteNodeDef(ask, actor.within)}`);
    lines.push("  end");
  }

  // 2. Remaining nodes top-level, in canonical node order.
  for (const node of graph.nodes) {
    if (laned.has(node.id)) continue;
    lines.push(`  ${siteNodeDef(node, undefined)}`);
  }

  // 3. Edges, in canonical edge order.
  for (const edge of graph.edges) lines.push(`  ${siteEdgeLine(edge)}`);

  // 4. A minimal palette: muted endpoints, world-reads, relays; asks stay default.
  lines.push(...classDefs(graph));
  return `${lines.join("\n")}\n`;
}

/** Subgraph title: `name (actor#1)`, plus a `  ×N per fan-out#K` marker for a lane family. */
function laneTitle(actor: ActorSite): string {
  const name = escapeLabel(actor.name ?? actor.id);
  const family = actor.within === undefined ? "" : `  ×N per ${actor.within}`;
  return `${name} (${actor.id})${family}`;
}

/**
 * A node definition in the kind's shape. `laneFamily` is the enclosing subgraph's
 * fan-out (undefined at top level); an ask omits its own `per fan-out#K` line only
 * when the lane already carries the same marker, to avoid double-labeling.
 */
function siteNodeDef(node: SiteNode, laneFamily: string | undefined): string {
  const id = safeId(node.id);
  if (node.kind === "source" || node.kind === "sink") {
    return `${id}([${quote(escapeLabel(node.label))}])`;
  }
  if (node.kind === "ask") {
    const parts = [escapeLabel(node.label), node.id];
    if (node.within !== undefined && node.within !== laneFamily) parts.push(`per ${node.within}`);
    return `${id}[${quote(parts.join("<br/>"))}]`;
  }
  if (node.kind === "world-read") {
    const parts = [escapeLabel(node.label), node.id];
    if (node.within !== undefined) parts.push(`per ${node.within}`);
    return `${id}[/${quote(parts.join("<br/>"))}/]`;
  }
  // An open hole: a subroutine shape (double bars) named by the hole and typed by T.
  if (node.kind === "hole") {
    const parts = [escapeLabel(node.label), node.id];
    if (node.artifactType !== undefined) parts.push(escapeLabel(node.artifactType));
    return `${id}[[${quote(parts.join("<br/>"))}]]`;
  }
  // join / fan-out: hexagon labeled by the original id (a stable folding target).
  const parts = [node.id];
  if (node.kind === "join" && node.within !== undefined) parts.push(`per ${node.within}`);
  return `${id}{{${quote(parts.join("<br/>"))}}}`;
}

function siteEdgeLine(edge: SiteEdge): string {
  const from = safeId(edge.from);
  const to = safeId(edge.to);
  // Context edges render as a dotted, arrowhead-less relation (not a flow).
  if (edge.kind === "context") return `${from} -. context .- ${to}`;
  const arrow = edge.exact ? "-->" : "-.->";
  // Label combines the join port (when present) and the producer artifact type,
  // as `port N · T`; either alone renders bare. Type text is escaped (user-derived).
  const parts: string[] = [];
  if (edge.port !== undefined) parts.push(`port ${edge.port}`);
  if (edge.type !== undefined) parts.push(escapeLabel(edge.type));
  if (parts.length === 0) return `${from} ${arrow} ${to}`;
  return `${from} ${arrow}|${quote(parts.join(" · "))}| ${to}`;
}

function classDefs(graph: SiteGraph): string[] {
  const idsOf = (kinds: SiteNode["kind"][]): string[] =>
    graph.nodes.filter((node) => kinds.includes(node.kind)).map((node) => safeId(node.id));
  const out = [
    "  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;",
    "  classDef world fill:#e8f0fe,stroke:#4285f4;",
    "  classDef relay fill:#fff2cc,stroke:#d6b656;",
  ];
  const endpoint = idsOf(["source", "sink"]);
  const world = idsOf(["world-read"]);
  const relay = idsOf(["join", "fan-out"]);
  const hole = idsOf(["hole"]);
  // 留白的 classDef 只在有留白时发：没有留白的脚本必须逐字节画出原来的图（快照钉住）。
  if (hole.length > 0)
    out.push("  classDef hole fill:#ffffff,stroke:#9a9aa5,stroke-dasharray: 4 3;");
  if (endpoint.length > 0) out.push(`  class ${endpoint.join(",")} endpoint;`);
  if (world.length > 0) out.push(`  class ${world.join(",")} world;`);
  if (relay.length > 0) out.push(`  class ${relay.join(",")} relay;`);
  if (hole.length > 0) out.push(`  class ${hole.join(",")} hole;`);
  return out;
}

/** Emit an {@link ActorGraph} as a mermaid `flowchart LR`. Deterministic node/edge order. */
export function actorGraphToMermaid(graph: ActorGraph): string {
  const lines: string[] = ["flowchart LR"];
  for (const node of graph.nodes) lines.push(`  ${actorNodeDef(node)}`);
  for (const edge of graph.edges) lines.push(`  ${actorEdgeLine(edge)}`);
  // Muted source/sink endpoints, mirroring the site chart's palette. Only class the
  // endpoints actually present — the agent-relevance filter may have pruned one.
  const endpoints = graph.nodes.filter((n) => n.id === "source" || n.id === "sink").map((n) => safeId(n.id));
  if (endpoints.length > 0) {
    lines.push("  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;");
    lines.push(`  class ${endpoints.join(",")} endpoint;`);
  }
  return `${lines.join("\n")}\n`;
}

function actorNodeDef(node: ActorNode): string {
  const id = safeId(node.id);
  if (node.id === "source" || node.id === "sink") return `${id}([${quote(node.id)}])`;
  if (node.id === "workspace") return `${id}[(${quote("workspace")})]`;
  // A lane family (actor site inside a fan-out) renders as `×N`.
  const label = escapeLabel(node.name ?? node.id) + (node.family === undefined ? "" : " ×N");
  return `${id}[${quote(label)}]`;
}

function actorEdgeLine(edge: ActorEdge): string {
  const from = safeId(edge.from);
  const to = safeId(edge.to);
  const arrow = edge.exact ? "-->" : "-.->";
  // Label is the message types joined `", "`, with a ` ×N` multiplicity suffix when
  // more than one site edge collapsed here; with no types, the bare `×N` (or nothing).
  if (edge.types !== undefined && edge.types.length > 0) {
    const label = edge.types.map(escapeLabel).join(", ") + (edge.count > 1 ? ` ×${edge.count}` : "");
    return `${from} ${arrow}|${quote(label)}| ${to}`;
  }
  if (edge.count > 1) return `${from} ${arrow}|${quote(`×${edge.count}`)}| ${to}`;
  return `${from} ${arrow} ${to}`;
}

/**
 * Emit a {@link CausalityGraph} as a mermaid `flowchart LR`: steps grouped into lane
 * subgraphs, the returned artifact as a terminal node, and ONE arrow form — no dashes,
 * no labels, no variants, exactly as the GUI renders it. `sequenceDiagram` was
 * considered and rejected for the same reason as loop frames: its `loop`/`par`/`alt`
 * blocks reintroduce the framing this design removes.
 */
export function causalityGraphToMermaid(graph: CausalityGraph): string {
  const lines: string[] = ["flowchart LR"];

  const byLane = new Map<string, Step[]>();
  for (const step of graph.steps) {
    const list = byLane.get(step.lane);
    if (list === undefined) byLane.set(step.lane, [step]);
    else list.push(step);
  }

  for (const lane of graph.lanes) {
    const steps = byLane.get(lane.id) ?? [];
    if (steps.length === 0) continue;
    lines.push(`  subgraph ${safeId(lane.id)}[${quote(causalityLaneTitle(lane))}]`);
    for (const step of steps) lines.push(`    ${stepNodeDef(step)}`);
    lines.push("  end");
  }

  if (graph.sink !== undefined) lines.push(`  sink([${quote("sink")}])`);
  for (const edge of graph.edges) lines.push(`  ${safeId(edge.from)} --> ${safeId(edge.to)}`);
  for (const from of graph.sink?.fedBy ?? []) lines.push(`  ${safeId(from)} --> sink`);

  if (graph.sink !== undefined) {
    lines.push("  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;");
    lines.push("  class sink endpoint;");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Emit the phase quotient as a mermaid `flowchart LR`: one node per phase, the same ONE
 * arrow form as the step graph (self-loops and back edges included — a cycle among the
 * arrows IS the loop), and the sink terminal derived from the phases of the steps that
 * feed the return. Absent vocabulary means no diagram: a script with no `phase()` markers
 * has nothing to draw here and the caller renders the step graph instead.
 */
export function phaseGraphToMermaid(graph: CausalityGraph): string {
  const lines: string[] = ["flowchart LR"];
  const phases = graph.phases ?? [];
  for (const phase of phases) {
    lines.push(`  ${safeId(phase.id)}[${quote(escapeLabel(phase.name ?? phase.id))}]`);
  }

  // Phase → sink is not an edge in the model (the quotient excludes the sink); it is
  // derived here from the fed-by steps' phases, in phase order.
  const phaseOf = new Map(graph.steps.map((step) => [step.id, step.phase]));
  const feeding = new Set(
    (graph.sink?.fedBy ?? []).map((id) => phaseOf.get(id)).filter((id) => id !== undefined),
  );
  if (graph.sink !== undefined) lines.push(`  sink([${quote("sink")}])`);
  for (const edge of graph.phaseEdges ?? []) {
    lines.push(`  ${safeId(edge.from)} --> ${safeId(edge.to)}`);
  }
  for (const phase of phases) {
    if (feeding.has(phase.id)) lines.push(`  ${safeId(phase.id)} --> sink`);
  }

  if (graph.sink !== undefined) {
    lines.push("  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;");
    lines.push("  class sink endpoint;");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Emit the phase-level CONTROL-FLOW quotient as a mermaid `flowchart LR`: the same phase
 * nodes as {@link phaseGraphToMermaid} so the two diagrams can be read side by side
 * ("what must precede what" vs "where execution can go next"), plus the `entry` / `sink` /
 * `abort` terminals. Arrows between one phase pair merge into one, labeled with the
 * distinct edge kinds behind it (`via` in parentheses); a pair joined only by `next`
 * renders unlabeled. Two phases that ran at the same time get one dashed `alongside` link
 * on top, drawn from the earlier to the later — a node fact about the pair, not a path.
 * Absent vocabulary means no diagram.
 */
export function phaseFlowToMermaid(flow: ControlFlowGraph): string {
  const lines: string[] = ["flowchart LR"];
  const phaseEdges = flow.phaseEdges ?? [];
  const terminals = [FLOW_ENTRY, FLOW_SINK, FLOW_ABORT].filter((id) =>
    phaseEdges.some((edge) => edge.from === id || edge.to === id),
  );
  for (const id of terminals) if (id === FLOW_ENTRY) lines.push(`  ${id}([${quote(id)}])`);
  for (const phase of flow.phases ?? []) {
    lines.push(`  ${safeId(phase.id)}[${quote(escapeLabel(phase.name ?? phase.id))}]`);
  }
  for (const id of terminals) if (id !== FLOW_ENTRY) lines.push(`  ${id}([${quote(id)}])`);

  const byPair = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const edge of phaseEdges) {
    const key = `${edge.from}|${edge.to}`;
    const entry = byPair.get(key) ?? { from: edge.from, labels: [], to: edge.to };
    const label = flowEdgeLabel(edge);
    if (!entry.labels.includes(label)) entry.labels.push(label);
    byPair.set(key, entry);
  }
  for (const { from, labels, to } of byPair.values()) {
    const shown = labels.filter((label) => label !== "next");
    const arrow = shown.length === 0 ? "-->" : `-->|${quote(shown.join(", "))}|`;
    lines.push(`  ${safeId(from)} ${arrow} ${safeId(to)}`);
  }
  // `alongside` is not a transfer of control, so it is drawn after the arrows and dashed:
  // one link per pair, from the earlier phase to the later one in phase-table order.
  const rank = new Map((flow.phases ?? []).map((phase, index) => [phase.id, index]));
  const drawn = new Set<string>();
  for (const phase of flow.phases ?? []) {
    for (const other of phase.alongside ?? []) {
      const earlier = (rank.get(phase.id) ?? rank.size) < (rank.get(other) ?? rank.size);
      const from = earlier ? phase.id : other;
      const to = earlier ? other : phase.id;
      if (drawn.has(`${from}|${to}`)) continue;
      drawn.add(`${from}|${to}`);
      lines.push(`  ${safeId(from)} -.->|${quote("alongside")}| ${safeId(to)}`);
    }
  }

  if (terminals.length > 0) {
    lines.push("  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;");
    lines.push(`  class ${terminals.join(",")} endpoint;`);
  }
  return `${lines.join("\n")}\n`;
}

function flowEdgeLabel(edge: FlowEdge): string {
  return edge.via === undefined ? edge.kind : `${edge.kind} (${edge.via})`;
}

/** Symbols for nested iteration multiplicity: one enclosing region each, in order. */
const MULTIPLICITY_SYMBOLS = ["N", "M", "K", "P"] as const;

/** Lane title: `name (actor#1)`, plus `×N·M` when enclosing iterations make it a family. */
function causalityLaneTitle(lane: Lane): string {
  const name = escapeLabel(lane.name ?? lane.id);
  const head = lane.name === undefined ? name : `${name} (${lane.id})`;
  const families = lane.families ?? [];
  if (families.length === 0) return head;
  // Nested iterations MULTIPLY, so depth 2 reads `×N·M`.
  const factors = families.map((_, index) => MULTIPLICITY_SYMBOLS[index] ?? "N").join("·");
  return `${head}  ×${factors}`;
}

/**
 * A step node: `label`, its site id, and `×N` when its instances coexist — the textual
 * stand-in for the GUI's stacked cards. A `serial` repeat needs no marker: the
 * cycle-closing arrow already carries it.
 */
function stepNodeDef(step: Step): string {
  const parts = [escapeLabel(step.label), step.id];
  if (step.repeat === "stack") parts.push("×N");
  if (step.lanes !== undefined) parts.push(`may: ${step.lanes.join("|")}`);
  const body = quote(parts.join("<br/>"));
  if (step.kind === "hole") return `${safeId(step.id)}[[${body}]]`;
  return step.kind === "world-read" ? `${safeId(step.id)}[/${body}/]` : `${safeId(step.id)}[${body}]`;
}

/**
 * Emit the OCCURRENCE-level control-flow graph as a mermaid `flowchart TD` — the full CFG
 * behind {@link phaseFlowToMermaid}'s quotient. Issue nodes are rectangles labelled by
 * their occurrence id; marks are hexagons labelled by the phase name they switch to; the
 * `entry` / `sink` / `abort` terminals share
 * the endpoint palette of every other chart. When the script declares phases, nodes sit in
 * one subgraph per phase (in `flow.phases` order) so a mark inside a loop reads as a jump
 * between boxes. Edges keep the graph's canonical order and are drawn one arrow per edge —
 * two edges between the same pair (`exit via=break` beside `next`) stay two arrows, because
 * at this level they ARE two ways to get there. `next` renders unlabeled, every other kind
 * carries {@link flowEdgeLabel}. Detached nodes (a never-called body) are dashed.
 */
export function controlFlowToMermaid(flow: ControlFlowGraph): string {
  const lines: string[] = ["flowchart TD"];
  const terminals = [FLOW_ENTRY, FLOW_SINK, FLOW_ABORT].filter((id) =>
    flow.edges.some((edge) => edge.from === id || edge.to === id),
  );
  const phaseName = new Map((flow.phases ?? []).map((phase) => [phase.id, phase.name ?? phase.id]));
  const nodeDef = (node: FlowNode): string => {
    const id = safeId(node.id);
    const tail = node.detached ? "<br/>detached" : "";
    if (node.kind === "mark") {
      return `${id}{{${quote(`${escapeLabel(phaseName.get(node.phase) ?? node.phase)}<br/>${node.id}${tail}`)}}}`;
    }
    return `${id}[${quote(`${node.id}${tail}`)}]`;
  };

  if (terminals.includes(FLOW_ENTRY)) lines.push(`  ${FLOW_ENTRY}([${quote(FLOW_ENTRY)}])`);
  if (flow.phases === undefined) {
    for (const node of flow.nodes) lines.push(`  ${nodeDef(node)}`);
  } else {
    for (const phase of flow.phases) {
      const members = flow.nodes.filter((node) => node.phase === phase.id);
      if (members.length === 0) continue;
      lines.push(`  subgraph ${safeId(phase.id)}[${quote(escapeLabel(phase.name ?? phase.id))}]`);
      for (const node of members) lines.push(`    ${nodeDef(node)}`);
      lines.push("  end");
    }
  }
  for (const id of terminals) if (id !== FLOW_ENTRY) lines.push(`  ${id}([${quote(id)}])`);

  for (const edge of flow.edges) {
    const arrow = edge.kind === "next" ? "-->" : `-->|${quote(flowEdgeLabel(edge))}|`;
    lines.push(`  ${safeId(edge.from)} ${arrow} ${safeId(edge.to)}`);
  }

  if (terminals.length > 0) {
    lines.push("  classDef endpoint fill:#eeeeef,stroke:#9a9aa5,color:#555566;");
    lines.push(`  class ${terminals.join(",")} endpoint;`);
  }
  const marks = flow.nodes.filter((node) => node.kind === "mark").map((node) => safeId(node.id));
  if (marks.length > 0) {
    lines.push("  classDef mark fill:#fff2cc,stroke:#d6b656;");
    lines.push(`  class ${marks.join(",")} mark;`);
  }
  const detached = flow.nodes.filter((node) => node.detached).map((node) => safeId(node.id));
  if (detached.length > 0) {
    lines.push("  classDef detached stroke-dasharray:4 3,color:#555566;");
    lines.push(`  class ${detached.join(",")} detached;`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Emit a {@link HandoffGraph} as a mermaid `flowchart LR`: one subgraph per phase (in the
 * analyzer's participant order, which IS the stack order), one card per participant, and
 * one arrow per hand-off — solid for a forward hand-off, dashed for a `back` one (all its
 * contributing edges were loop carries), labelled with the artifact `types` when known.
 * The graph itself carries only ids; pass the causality graph's `lanes` / `phases` to
 * label cards and boxes with the author's names, exactly as `serializeHandoffGraph` echoes
 * lane names for readability.
 */
export function handoffGraphToMermaid(
  graph: HandoffGraph,
  names: Pick<CausalityGraph, "lanes" | "phases"> = { lanes: [] },
): string {
  const lines: string[] = ["flowchart LR"];
  const laneName = new Map(names.lanes.map((lane) => [lane.id, lane.name]));
  const phaseName = new Map((names.phases ?? []).map((phase) => [phase.id, phase.name ?? phase.id]));

  const byPhase = new Map<string, HandoffParticipant[]>();
  for (const participant of graph.participants) {
    const list = byPhase.get(participant.phase);
    if (list === undefined) byPhase.set(participant.phase, [participant]);
    else list.push(participant);
  }
  for (const [phase, participants] of byPhase) {
    lines.push(`  subgraph ${safeId(phase)}[${quote(escapeLabel(phaseName.get(phase) ?? phase))}]`);
    for (const participant of participants) {
      lines.push(`    ${participantNodeDef(participant, laneName.get(participant.lane))}`);
    }
    lines.push("  end");
  }
  for (const handoff of graph.handoffs) lines.push(`  ${handoffEdgeLine(handoff)}`);

  const workspace = graph.participants
    .filter((participant) => participant.lane === WORKSPACE_LANE)
    .map((participant) => safeId(participant.id));
  if (workspace.length > 0) {
    lines.push("  classDef world fill:#e8f0fe,stroke:#4285f4;");
    lines.push(`  class ${workspace.join(",")} world;`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A participant card: the lane's name (or id) with its multiplicity — `[i/N]` for a
 * literal-cardinality member, `×N` for a family of unknown size — over the steps it holds.
 * The workspace lane is a cylinder, as in the actor chart.
 */
function participantNodeDef(participant: HandoffParticipant, name: string | undefined): string {
  const id = safeId(participant.id);
  let head = escapeLabel(name ?? participant.lane);
  if (participant.member !== undefined) head += ` [${participant.member.index + 1}/${participant.member.of}]`;
  if (participant.many) head += " ×N";
  const body = quote(`${head}<br/>${participant.steps.join(", ")}`);
  return participant.lane === WORKSPACE_LANE ? `${id}[(${body})]` : `${id}[${body}]`;
}

function handoffEdgeLine(handoff: Handoff): string {
  const from = safeId(handoff.from);
  const to = safeId(handoff.to);
  const arrow = handoff.back ? "-.->" : "-->";
  if (handoff.types === undefined || handoff.types.length === 0) return `${from} ${arrow} ${to}`;
  return `${from} ${arrow}|${quote(handoff.types.map(escapeLabel).join(", "))}| ${to}`;
}
