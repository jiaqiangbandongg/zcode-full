import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ConversationShareWorkflowContentBlock,
  ShareWorkflowArtifact,
  Locale,
} from "@zcode/shared";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { WorkflowCompletionCard } from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
class ContentBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SharedArtifact({
  artifact,
  url,
  onOpenResource,
}: {
  artifact: ShareWorkflowArtifact;
  url?: string;
  onOpenResource?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const previewText = "preview_text" in artifact ? artifact.preview_text : undefined;
  const [text, setText] = useState<string | undefined>(previewText);
  const [failed, setFailed] = useState(false);
  const contentType = "content_type" in artifact ? artifact.content_type : undefined;
  const readable = artifact.kind === "markdown" || contentType?.startsWith("text/");
  useEffect(() => {
    setText(previewText);
    setFailed(false);
    if (previewText !== undefined || !url || !readable || artifact.unavailable) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Artifact unavailable");
        const body = await response.text();
        if (!controller.signal.aborted) setText(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [url, readable, artifact.unavailable, previewText]);
  if (artifact.unavailable)
    return (
      <p>
        {intl.formatMessage({ id: "conversationShare.artifact.notIncluded" })} ·{" "}
        {intl.formatMessage({
          id: {
            source_unavailable: "conversationShare.artifact.sourceUnavailable",
            unsupported: "conversationShare.artifact.unsupported",
            limit_exceeded: "conversationShare.artifact.limitExceeded",
          }[artifact.unavailable],
        })}
      </p>
    );
  if (artifact.kind !== "file" && artifact.kind !== "markdown")
    return (
      <ArtifactPresetBody
        artifact={artifact}
        items={artifact.items ?? []}
        labels={buildPresetLabels(intl.formatMessage.bind(intl))}
        missingLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardUnavailable" })}
        invalidLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardInvalid" })}
      />
    );
  const resourceId = artifact.resource_id;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {intl.formatMessage({ id: "conversationShare.artifact.openDownload" })}
        </a>
      ) : resourceId && onOpenResource ? (
        <button
          type="button"
          onClick={() => onOpenResource(resourceId)}
          className="self-start text-primary underline"
        >
          {intl.formatMessage({ id: "conversationShare.artifact.openFile" })}
        </button>
      ) : (
        <p>{intl.formatMessage({ id: "conversationShare.artifact.resourceUnavailable" })}</p>
      )}
      {failed ? (
        <p>{intl.formatMessage({ id: "conversationShare.artifact.previewFailed" })}</p>
      ) : readable && (url || previewText !== undefined) ? (
        text === undefined ? (
          <p>{intl.formatMessage({ id: "conversationShare.artifact.loading" })}</p>
        ) : (
          <MessageResponse renderZCodeFileCitations={false}>{text}</MessageResponse>
        )
      ) : contentType?.startsWith("image/") && url ? (
        <img src={url} alt={artifact.title} className="max-w-full" />
      ) : null}
    </div>
  );
}

function WorkflowContent({
  block,
  artifactUrls,
  locale,
  onOpenResource,
}: {
  block: ConversationShareWorkflowContentBlock;
  artifactUrls: ReadonlyMap<string, string>;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  const { payload } = block;
  const [selected, setSelected] = useState<string>();
  const [runOpen, setRunOpen] = useState(false);
  const run = useMemo(
    () => (payload.run ? { ...payload.run, runId: block.id } : undefined),
    [payload.run, block.id],
  );
  const model = useMemo(
    () => (payload.graph && run ? buildWorkflowTimeline(payload.graph, run) : undefined),
    [payload.graph, run],
  );
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const detail = workflowCardDetail(format, model, payload.graph, run);
  const selectedArtifact = payload.artifacts.find((artifact) => artifact.id === selected);
  const figures = {
    ...(payload.duration_ms === undefined ? {} : { durationMs: payload.duration_ms }),
    ...(run
      ? { tokens: run.usage.spentTokens, subagents: run.actors.length, phases: run.phases?.length }
      : {}),
  };
  return (
    <div className="min-w-0" data-share-content-block={block.id}>
      {payload.completion ? (
        <WorkflowCompletionCard
          name={payload.name}
          figures={figures}
          artifacts={payload.artifacts.map((artifact) => ({
            ...artifact,
            ...(artifact.kind === "file" || artifact.kind === "markdown"
              ? { contentType: artifact.content_type }
              : { itemCount: artifact.items?.length ?? 0 }),
          }))}
          onOpenArtifact={setSelected}
          onOpenRun={model ? () => setRunOpen(true) : undefined}
          testIdKey={block.id}
        />
      ) : (
        <section
          className="wf-motion flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5"
          data-share-workflow-run
        >
          <WorkflowCardHeader
            name={payload.name}
            kind={
              run
                ? format({ id: workflowRunKindMessageId(run) })
                : intl.formatMessage({ id: "conversationShare.workflowUnavailable" })
            }
            detail={detail?.detail}
            expanded
            live={false}
            onOpenDetails={model ? () => setRunOpen(true) : undefined}
          />
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={setSelected}
            className="pb-0.5 pt-0.5"
          />
        </section>
      )}
      {payload.unavailable ? (
        <p className="mt-2 text-ui-sm">
          {intl.formatMessage({ id: "conversationShare.workflowPartial" })}
        </p>
      ) : null}
      <p
        className="mt-1 text-ui-xs text-foreground-subtlest"
        title={new Date(block.captured_at).toLocaleString(locale)}
      >
        {intl.formatMessage({ id: "conversationShare.capturedSnapshot" })}
      </p>
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{payload.name}</DialogTitle>
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={(id) => {
              setRunOpen(false);
              setSelected(id);
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={selectedArtifact !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{selectedArtifact?.title}</DialogTitle>
          {selectedArtifact ? (
            <SharedArtifact
              artifact={selectedArtifact}
              url={
                "resource_id" in selectedArtifact && selectedArtifact.resource_id
                  ? artifactUrls.get(selectedArtifact.resource_id)
                  : undefined
              }
              onOpenResource={onOpenResource}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 注册表只接入经过公开 schema 的类型；未知块由时间线保留原摘要。 */
const CONTENT_RENDERERS = { workflow: WorkflowContent };
export function ConversationShareContent({
  blocks,
  fallbacks,
  ...props
}: {
  blocks: readonly ConversationShareWorkflowContentBlock[];
  fallbacks: ReadonlyMap<number, string>;
  artifactUrls: ReadonlyMap<string, string>;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocks.map((block) => {
        const Renderer = CONTENT_RENDERERS[block.type];
        const fallback = (
          <div className="whitespace-pre-wrap">{fallbacks.get(block.fallback_row_id)}</div>
        );
        return (
          <ContentBoundary key={block.id} fallback={fallback}>
            <Renderer block={block} {...props} />
          </ContentBoundary>
        );
      })}
    </div>
  );
}
