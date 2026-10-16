import type { ActorEdge, ActorGraph, ActorNode } from "./actor-graph.js";
import type {
  CausalityGraph,
  Lane,
  NamePattern,
  OrderEdge,
  Phase,
  Region,
  Step,
} from "./causality-graph.js";
import type { ControlFlowGraph, FlowEdge } from "./flow-graph.js";
import type { HandoffGraph } from "./handoff-graph.js";
import type { ActorSite, SiteEdge, SiteGraph, SiteNode } from "./types.js";

/** Quote a type string for a `type=`/`types=` field: embedded `"` escaped as `\"`. */
function quoteType(type: string): string {
  return `"${type.replace(/"/g, '\\"')}"`;
}

/**
 * Canonical, deterministic text form of a site graph — the snapshot and debugging
 * surface. Grammar:
 *
 *   node source
 *   node ask#1 "scanner" @3:24 actors=actor#1 type="Flaky"
 *   node ask#2 "judge" @8:20 within=fan-out#1
 *   node sink
 *   actor actor#1 "planner" @5:17
 *   actor actor#2 "judge" @8:14 within=fan-out#1
 *   edge ask#1 -> ask#2 data exact type="Flaky"
 *   edge join#1 -> sink data inexact port=2 type="Review"
 *
 * Nodes come first (virtual `source` first, `sink` last, sites between in source
 * order); then actors in source order; then edges. `source`/`sink` carry no label
 * or location. `ask` nodes carry a trailing `actors=...` lane membership when
 * non-empty; any node or actor lexically inside a promoted fan-out carries a
 * trailing `within=fan-out#N` (after `actors=` when both are present); a producer
 * node/edge carries a trailing `type="<artifactType>"` last, when known (the type
 * string is quoted with embedded `"` escaped as `\"`, since a string-literal-union
 * artifact type can contain quotes, e.g. `ask<"yes" | "no">`). Edges are sorted by
 * (from position, to position, kind, port).
 */
export function serializeGraph(graph: SiteGraph): string {
  const source = graph.nodes.filter((node) => node.kind === "source");
  const sink = graph.nodes.filter((node) => node.kind === "sink");
  const middle = graph.nodes.filter((node) => node.kind !== "source" && node.kind !== "sink");
  const ordered = [...source, ...middle, ...sink];

  const position = new Map<string, number>(ordered.map((node, index) => [node.id, index]));
  const edges = [...graph.edges].sort((a, b) => compareEdges(a, b, position));

  const lines = [
    ...ordered.map(renderNode),
    ...graph.actors.map(renderActor),
    ...edges.map(renderEdge),
  ];
  return `${lines.join("\n")}\n`;
}

function renderNode(node: SiteNode): string {
  if (node.loc === undefined) return `node ${node.id}`;
  let line = `node ${node.id} "${node.label}" @${node.loc.line}:${node.loc.column}`;
  if (node.actors !== undefined && node.actors.length > 0) line += ` actors=${node.actors.join(",")}`;
  if (node.within !== undefined) line += ` within=${node.within}`;
  if (node.artifactType !== undefined) line += ` type=${quoteType(node.artifactType)}`;
  return line;
}

function renderActor(actor: ActorSite): string {
  const name = actor.name === undefined ? "" : ` "${actor.name}"`;
  let line = `actor ${actor.id}${name} @${actor.loc.line}:${actor.loc.column}`;
  if (actor.within !== undefined) line += ` within=${actor.within}`;
  return line;
}

function renderEdge(edge: SiteEdge): string {
  const exact = edge.exact ? "exact" : "inexact";
  const port = edge.port === undefined ? "" : ` port=${edge.port}`;
  const type = edge.type === undefined ? "" : ` type=${quoteType(edge.type)}`;
  return `edge ${edge.from} -> ${edge.to} ${edge.kind} ${exact}${port}${type}`;
}

function compareEdges(a: SiteEdge, b: SiteEdge, position: Map<string, number>): number {
  const rank = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return (
    rank(a.from) - rank(b.from) ||
    rank(a.to) - rank(b.to) ||
    a.kind.localeCompare(b.kind) ||
    (a.port ?? -1) - (b.port ?? -1)
  );
}

/**
 * Canonical text form of the derived {@link ActorGraph} (its own snapshot surface,
 * a sibling of {@link serializeGraph}). Grammar:
 *
 *   actor-node main
 *   actor-node workspace
 *   actor-node actor#1 "planner" @17:17
 *   actor-node actor#2 "judge" @29:32 family=fan-out#1
 *   actor-edge main -> actor#1 exact count=1
 *   actor-edge actor#1 -> actor#2 inexact count=2 types="Plan","Review"
 *
 * Nodes come first in node order (already `main`, then `workspace` when present,
 * then actors in site order); edges follow, sorted by (from position, to position).
 * `main`/`workspace` carry no name or location; actor nodes carry a `"name"` when
 * known, always a location, and a trailing `family=fan-out#N` when they are a lane
 * family (their site sits inside a promoted fan-out). An actor edge carries a trailing
 * `types="A","B"` (each type individually quoted, embedded `"` escaped as `\"` — type
 * strings can contain quotes, e.g. `ask<"yes" | "no">`) when it carries message types.
 */
export function serializeActorGraph(graph: ActorGraph): string {
  const position = new Map<string, number>(graph.nodes.map((node, index) => [node.id, index]));
  const rank = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  const edges = [...graph.edges].sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to));
  const lines = [...graph.nodes.map(renderActorNode), ...edges.map(renderActorEdge)];
  return `${lines.join("\n")}\n`;
}

function renderActorNode(node: ActorNode): string {
  let line = `actor-node ${node.id}`;
  if (node.name !== undefined) line += ` "${node.name}"`;
  if (node.loc !== undefined) line += ` @${node.loc.line}:${node.loc.column}`;
  if (node.family !== undefined) line += ` family=${node.family}`;
  return line;
}

function renderActorEdge(edge: ActorEdge): string {
  let line = `actor-edge ${edge.from} -> ${edge.to} ${edge.exact ? "exact" : "inexact"} count=${edge.count}`;
  if (edge.types !== undefined && edge.types.length > 0) {
    line += ` types=${edge.types.map(quoteType).join(",")}`;
  }
  return line;
}

/**
 * Canonical text form of the {@link CausalityGraph} — its snapshot and debugging
 * surface, third sibling of {@link serializeGraph} / {@link serializeActorGraph}.
 * Grammar:
 *
 *   phase unphased
 *   phase phase#1 "preflight" @3:1
 *   lane workspace
 *   lane actor#2 "planner" @17:17
 *   lane actor#4 "judge" @29:32 families=fanout#1
 *   lane actor#1 name-head="研究员" @53:5 families=fanout#1
 *   region seq#1 seq
 *   region loop#1 loop parent=seq#1 @21:1 bound=5
 *   step ask#1 ask "scanner" @14:41 lane=actor#1 region=seq#1 always
 *   step ask#4 ask "judge" @29:47 lane=actor#4 region=fanout#1 maybe stack
 *   step ask#2~actor#1 ask "move" @12:40 lane=actor#1 lanes=actor#1,actor#2 source=ask#2 \
 *     phase=phase#2 region=loop#1 maybe serial
 *   edge ask#1 -> ask#2 seq always
 *   edge ask#3 -> ask#2 carry always
 *   phase-edge phase#1 -> phase#2 seq always
 *   sink ask#2,ask#4
 *
 * Sections are fixed: phases (when the script declares any marker at all — see below),
 * lanes (workspace first, then actors in creation order, `unknown`
 * last), regions in creation order, steps in source order, edges in the graph's
 * canonical order, the phase quotient's edges, then the sink line when the script returns
 * an artifact. `lanes=`
 * appears on a step whose receiver is a may-set and `source=` only on a may-set COPY (so
 * a step that did not expand serializes exactly as it did pre-expansion); `exact`/`inexact`
 * only on `data` edges, where the bit means something.
 *
 * The phase vocabulary — `phase` lines, the step's `phase=` field, `phase-edge` lines —
 * appears only when the script declares at least one `phase("…")` marker, and then all
 * three appear. A script with no markers serializes byte-for-byte as it did before phase
 * annotations existed; that is the regression nail the whole fixture corpus stands on.
 *
 * `name-head=`/`name-tail=` (lane) and `label-head=`/`label-tail=` (step) carry a
 * {@link NamePattern} — the static shape of a name the script interpolates. They sit in
 * the same slot as the quoted name they stand in for, and they carry the affixes as
 * **data**: the ellipsis that turns them into `研究员…` is a render-time decision, not
 * part of this form.
 */
export function serializeCausalityGraph(graph: CausalityGraph): string {
  const lines = [
    ...(graph.phases ?? []).map(renderPhase),
    ...graph.lanes.map(renderLane),
    ...graph.regions.map(renderRegion),
    ...graph.steps.map(renderStep),
    ...graph.edges.map(renderOrderEdge),
    ...(graph.phaseEdges ?? []).map(renderPhaseEdge),
    ...(graph.sink === undefined ? [] : [`sink ${graph.sink.fedBy.join(",")}`]),
  ];
  return `${lines.join("\n")}\n`;
}

function renderPhase(phase: Phase): string {
  let line = `phase ${phase.id}`;
  if (phase.name !== undefined) line += ` "${phase.name}"`;
  if (phase.loc !== undefined) line += ` @${phase.loc.line}:${phase.loc.column}`;
  if (phase.fill !== undefined) line += ` fill=${phase.fill}`;
  return line;
}

function renderPhaseEdge(edge: OrderEdge): string {
  return `phase-edge ${edge.from} -> ${edge.to} ${edge.kind} ${edge.certainty}`;
}

function renderLane(lane: Lane): string {
  let line = `lane ${lane.id}`;
  if (lane.name !== undefined) line += ` "${lane.name}"`;
  line += renderNamePattern("name", lane.namePattern);
  if (lane.loc !== undefined) line += ` @${lane.loc.line}:${lane.loc.column}`;
  if (lane.families !== undefined && lane.families.length > 0) {
    line += ` families=${lane.families.join(",")}`;
  }
  return line;
}

/** `name-head="研究员" name-tail="-worker"` — affixes as data, never the rendered glyph. */
function renderNamePattern(field: "name" | "label", pattern: NamePattern | undefined): string {
  if (pattern === undefined) return "";
  let out = "";
  if (pattern.head !== undefined) out += ` ${field}-head=${quoteType(pattern.head)}`;
  if (pattern.tail !== undefined) out += ` ${field}-tail=${quoteType(pattern.tail)}`;
  return out;
}

function renderRegion(region: Region): string {
  let line = `region ${region.id} ${region.kind}`;
  if (region.parent !== undefined) line += ` parent=${region.parent}`;
  if (region.loc !== undefined) line += ` @${region.loc.line}:${region.loc.column}`;
  if (region.bound !== undefined) line += ` bound=${region.bound}`;
  if (region.label !== undefined) line += ` label=${quoteType(region.label)}`;
  return line;
}

function renderStep(step: Step): string {
  let line = `step ${step.id} ${step.kind} "${step.label}"`;
  line += renderNamePattern("label", step.labelPattern);
  line += ` @${step.loc.line}:${step.loc.column}`;
  line += ` lane=${step.lane}`;
  if (step.lanes !== undefined) line += ` lanes=${step.lanes.join(",")}`;
  if (step.source !== undefined) line += ` source=${step.source}`;
  if (step.phase !== undefined) line += ` phase=${step.phase}`;
  line += ` region=${step.region} ${step.certainty}`;
  if (step.repeat !== undefined) line += ` ${step.repeat}`;
  if (step.fill !== undefined) line += ` fill=${step.fill}`;
  return line;
}

function renderOrderEdge(edge: OrderEdge): string {
  let line = `edge ${edge.from} -> ${edge.to} ${edge.kind} ${edge.certainty}`;
  if (edge.exact !== undefined) line += edge.exact ? " exact" : " inexact";
  return line;
}

/**
 * Canonical text form of the control-flow graph,
 * fifth sibling of the serializers above:
 *
 *   phase phase#1 "preflight"
 *   phase phase#2 "review" alongside=phase#1
 *   phase hole#21b40fca "决定分组"
 *   hole hole#cd7e8315 "评判" type="Verdict" phase=phase#2 tail
 *   node ask#1@1 issue site=ask#1 phase=phase#2
 *   node phase#6@1 mark phase=phase#6 alongside=phase#1,phase#2
 *   node ask#9@1 issue site=ask#9 phase=unphased detached
 *   edge entry -> world-read#2@1 next
 *   edge world-read#4@1 -> ask#1@1 loop via=continue
 *   edge ask#3@1 -> abort throw
 *   phase-edge phase#3 -> phase#2 loop via=continue
 *
 * Nodes in leaf-stream order, edges in the graph's canonical order (`entry` first, the
 * terminals last). `phase` and `phase-edge` lines appear only when the script declares a
 * marker — the same all-or-nothing contract as the causality serializer's phase vocabulary.
 * `alongside` (a mark's, and its phase's union) names the phases whose strands were still
 * running when the marker was entered; it is a node fact, never an edge. `fill=` on a phase
 * names the filled hole whose body wrote it; a `hole` line is an OPEN hole with the phase it
 * stands in and `tail` when it is the script's open end (docs/analysis.md「Sites」).
 */
export function serializeControlFlow(flow: ControlFlowGraph): string {
  const edgeLine = (head: string, edge: FlowEdge): string =>
    `${head} ${edge.from} -> ${edge.to} ${edge.kind}${edge.via === undefined ? "" : ` via=${edge.via}`}`;
  const lines = [
    ...(flow.phases ?? []).map(
      (phase) =>
        `phase ${phase.id}${phase.name === undefined ? "" : ` ${quoteType(phase.name)}`}` +
        (phase.alongside === undefined ? "" : ` alongside=${phase.alongside.join(",")}`) +
        (phase.fill === undefined ? "" : ` fill=${phase.fill}`),
    ),
    ...(flow.holes ?? []).map(
      (hole) =>
        `hole ${hole.siteId} ${quoteType(hole.name)} type=${quoteType(hole.type)}` +
        (hole.phase === undefined ? "" : ` phase=${hole.phase}`) +
        (hole.tail ? " tail" : ""),
    ),
    ...flow.nodes.map(
      (node) =>
        `node ${node.id} ${node.kind}` +
        (node.site === undefined ? "" : ` site=${node.site}`) +
        ` phase=${node.phase}` +
        (node.alongside === undefined ? "" : ` alongside=${node.alongside.join(",")}`) +
        (node.detached ? " detached" : ""),
    ),
    ...flow.edges.map((edge) => edgeLine("edge", edge)),
    ...(flow.phaseEdges ?? []).map((edge) => edgeLine("phase-edge", edge)),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Canonical text form of the hand-off graph,
 * snapshotted as `<fixture>.handoff.txt`. Participants in the analyzer's order (which IS
 * the stack order), grouped under their phase; the lane's literal name is echoed for
 * readability only — `lanes` carries it in the payload.
 */
export function serializeHandoffGraph(graph: HandoffGraph, lanes: readonly Lane[]): string {
  const nameOf = new Map(lanes.map((lane) => [lane.id, lane.name]));
  const lines: string[] = [];
  let phase: string | undefined;
  for (const participant of graph.participants) {
    if (participant.phase !== phase) {
      phase = participant.phase;
      lines.push(`phase ${phase}`);
    }
    let line = `participant ${participant.id}`;
    const name = nameOf.get(participant.lane);
    if (name !== undefined) line += ` ${quoteType(name)}`;
    if (participant.member !== undefined) line += ` member=${participant.member.index}/${participant.member.of}`;
    if (participant.many) line += " many";
    line += ` steps=${participant.steps.join(",")}`;
    lines.push(line);
  }
  for (const edge of graph.handoffs) {
    let line = `handoff ${edge.from} -> ${edge.to}`;
    if (edge.back) line += " back";
    if (edge.types !== undefined) line += ` types=${quoteType(edge.types.join(","))}`;
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}
