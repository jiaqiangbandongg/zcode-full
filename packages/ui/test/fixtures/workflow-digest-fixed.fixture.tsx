import { AvatarCluster, SpineRail } from "@/app-shell/WorkflowRunSpineParts.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import "@/styles.css";
import { createRoot } from "react-dom/client";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
const LOOP_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask",
      label: "plan",
      line: 2,
      column: 21,
      lane: "actor#1",
      phase: "phase#a",
    },
    {
      id: "ask#2",
      kind: "ask",
      label: "verify",
      line: 5,
      column: 21,
      lane: "actor#2",
      phase: "phase#b",
    },
  ],
  lanes: [
    { id: "actor#1", name: "planner", line: 1, column: 11 },
    { id: "actor#2", name: "checker", line: 4, column: 11 },
  ],
  participants: [
    { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"] },
    { id: "phase#b:actor#2", phase: "phase#b", lane: "actor#2", steps: ["ask#2"] },
  ],
  handoffs: [],
  phases: [
    { id: "phase#a", name: "plan", line: 1 },
    { id: "phase#b", name: "verify", line: 4 },
  ],
  phaseEdges: [
    { from: "phase#a", to: "phase#b" },
    { from: "phase#b", to: "phase#a", back: true },
  ],
  exits: ["phase#b"],
} as const;

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-42",
    toolCallId: "tool-create-workflow",
    status: "running",
    usage: { spentTokens: 1_234, nodesUsed: 2 },
    actors: [
      { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
      { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "running" },
    ],
    nodes: [
      {
        siteId: "ask#1",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
      { siteId: "ask#2", ordinal: 1, phase: "executing", actorSiteId: "actor#2", actorOrdinal: 1 },
    ] as WorkflowRunState["nodes"],
    lastEventSequence: 7,
    ...overrides,
  };
}

function joined(
  overrides: Partial<WorkflowRunState> = {},
  extra: Partial<WorkflowRunCardSummary> = {},
): WorkflowRunCardSummary {
  const run = runState(overrides);
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    nodesSettled: run.nodes.filter((node) => node.phase === "settled").length,
    nodesTotal: run.nodes.length,
    run,
    ...extra,
  };
}

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <div className="relative h-8" data-testid="spine-preview">
        <SpineRail ink="march" position="above" />
      </div>
      <AvatarCluster
        pills={buildWorkflowTimeline(LOOP_GRAPH, runState()).stations.flatMap(
          (station) => station.pills,
        )}
        nameOf={(pill) => pill.runtimeName ?? pill.lane.name}
      />
      <WorkflowRunDigest
        graph={LOOP_GRAPH}
        runId={joined().runId}
        summary={joined()}
        name="Fixed workflow"
        testIdKey="fixed"
        onOpenPill={() => {
          document.body.dataset.agentOpened = "true";
        }}
        onOpenRun={() => {
          document.body.dataset.open = "true";
        }}
      />
      <WorkflowRunDigest
        graph={undefined}
        runId={joined().runId}
        summary={joined({ status: "stopped", stopReason: "user" }, { resumable: true })}
        name="Resume workflow"
        testIdKey="resume"
        onResume={() => {
          document.body.dataset.resumed = "true";
        }}
      />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
