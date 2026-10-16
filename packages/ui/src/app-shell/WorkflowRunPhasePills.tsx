import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type {
  TimelinePill,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { pillActivity } from "@/components/workflow-timeline/timeline-pill-activity.js";
import { pillInstanceKey } from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  SpinePillTrailer,
  type useWorkflowActorModelLabels,
} from "@/app-shell/WorkflowRunSpineParts.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";

/**
 * 详情页脊线上药丸的接线（docs/dynamic-workflow/presentation.md「The spine」）。从
 * WorkflowRunPhaseList.tsx 拆出（max-lines 门）：那里只管节的开合、落点与留白，药丸怎么命名、怎么打开、
 * 尾槽写什么全在这里。纯函数工厂：清单每帧调用一次拿到三把闭包，没有自己的状态。
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface PhasePillRenderers {
  nameOf: (pill: TimelinePill) => string;
  pillProps: (pill: TimelinePill) => Parameters<typeof WorkflowAgentPill>[0];
  renderPill: (pill: TimelinePill) => JSX.Element;
}

export function phasePillRenderers({
  actorModels,
  format,
  graph,
  model,
  now,
  onOpenActor,
  onOpenWorkspace,
  questionsByInstance,
  run,
}: {
  model: WorkflowTimelineModel;
  graph: WorkflowCausalityGraphData;
  run: WorkflowRunState | undefined;
  format: FormatMessage;
  actorModels: ReturnType<typeof useWorkflowActorModelLabels>;
  questionsByInstance: ReadonlyMap<string, WorkflowRunPendingQuestion[]>;
  now: number;
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  onOpenWorkspace?: (phaseId: string) => void;
}): PhasePillRenderers {
  const pillKey = pillInstanceKey;
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // 行交出槽位身份：会话 id 有则随行，没有就开占位 tab。
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** 药丸的公共接线（名字、状态、可打开）；整行药丸与「列出全部」的密排药丸共用。 */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // 脚本行同一条打开语法：开整个 run 的脚本 transcript，落到这一站的第一张卡。
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    const actorModel = actorModels.get(pillKey(pill) ?? "");
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: actorModel === undefined ? label : `${label}\n${actorModel.canonical}`,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // 可打开的药丸是 <button>：块级父元素里它只包住内容，行宽会随名字长短参差。
    // 纵向 flex 容器让每一行拉满本列宽度（与卡上站下的药丸列同一机制）。
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          <SpinePillTrailer counts={counts} modelName={actorModels.get(key ?? "")?.name} />
        </WorkflowAgentPill>
        {/* 问题挂在提问者下面，再退一步（26px）：它属于这一行，不属于这一站。 */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return { nameOf, pillProps, renderPill };
}
