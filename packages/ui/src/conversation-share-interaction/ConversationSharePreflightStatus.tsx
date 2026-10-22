import type {
  ConversationSharePreflightState,
  ConversationSharePreflightStatusProps,
} from "@/conversation-share-interaction/contract.js";
export type {
  ConversationSharePreflightState,
  ConversationSharePreflightStatusProps,
} from "@/conversation-share-interaction/contract.js";
import { memo } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { ConversationShareFailureIssue } from "@/conversation-share-interaction/contract.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

// 修复原因：memo 组件的默认对象每次创建会破坏引用稳定性；idle 默认值仅供读取。
const DEFAULT_PREFLIGHT: ConversationSharePreflightState = {
  status: "idle",
};

function ConversationSharePreflightStatusImpl({
  onDeselectTurn,
  onRetryPreflight,
  preflight = DEFAULT_PREFLIGHT,
}: ConversationSharePreflightStatusProps) {
  const { intl, locale } = useZCodeIntl();
  const blockingIssues = "blockingIssues" in preflight ? preflight.blockingIssues : [];
  const skippableWarnings = "skippableWarnings" in preflight ? preflight.skippableWarnings : [];
  const deferredIssues = "deferredIssues" in preflight ? preflight.deferredIssues : [];
  const checking =
    preflight.status === "checking" || preflight.status === "stale" || preflight.status === "idle";
  const statusCount = blockingIssues.length || skippableWarnings.length || deferredIssues.length;
  const statusLabel = checking
    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
    : blockingIssues.length > 0
      ? intl.formatMessage({ id: "conversationShare.partial.preflightBlocked" })
      : skippableWarnings.length > 0
        ? intl.formatMessage(
            { id: "conversationShare.partial.preflightSkipped" },
            { count: skippableWarnings.length },
          )
        : deferredIssues.length > 0
          ? intl.formatMessage({
              id: "conversationShare.partial.preflightDeferred",
            })
          : "";
  const triggerLabel = intl.formatMessage({
    id:
      blockingIssues.length > 0
        ? "conversationShare.preflight.reviewIssues"
        : skippableWarnings.length > 0
          ? "conversationShare.preflight.reviewSkipped"
          : "conversationShare.preflight.reviewDeferred",
  });
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };
  const formatIssueValues = (issue: ConversationShareFailureIssue) => ({
    turnOrdinal: issue.turnOrdinal ?? "—",
    artifactDisplayName: issue.artifactDisplayName ?? "—",
    artifactType: formatConversationShareArtifactType(issue, locale),
    extension: issue.extension ?? "—",
    mimeType: issue.mimeType ?? "—",
    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
    actual: formatValue(issue.actual, issue.code),
    limit: formatValue(issue.limit, issue.code),
    phase: issue.phase ?? "—",
  });

  // 浮窗的检查态由范围按钮承载，此处只保留可操作的诊断，避免多占一行。
  if (checking || statusCount === 0) return null;

  return (
    <section
      data-conversation-share-keep-open="selection-dock"
      data-testid="conversation-share-selection-dock"
      className="flex items-center text-ui-sm text-foreground"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="conversation-share-selection-preflight-status"
            aria-label={triggerLabel}
            title={statusLabel}
            aria-busy={checking}
            className="flex min-w-0 items-start gap-1.5 text-left text-ui-sm leading-5 text-foreground-subtle hover:text-foreground"
          >
            {blockingIssues.length > 0 ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : skippableWarnings.length > 0 ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0">{triggerLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          collisionPadding={12}
          data-testid="conversation-share-selection-preflight-popover"
          className="w-96 max-w-[calc(100vw-1.5rem)] gap-2 p-3"
        >
          <PopoverTitle className="text-ui-base font-medium">{statusLabel}</PopoverTitle>
          <ul className="grid max-h-56 gap-2 overflow-y-auto text-ui-base">
            {[...blockingIssues, ...skippableWarnings, ...deferredIssues]
              .slice(0, 5)
              .map((issue, index) => (
                <li
                  key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                  className="grid gap-1"
                >
                  <span>
                    {intl.formatMessage(
                      {
                        id: blockingIssues.includes(issue)
                          ? resolveConversationShareIssueMessageId(issue)
                          : resolveConversationShareWarningMessageId(issue),
                      },
                      formatIssueValues(issue),
                    )}
                  </span>
                  {blockingIssues.includes(issue) &&
                  issue.productTurnId !== undefined &&
                  onDeselectTurn ? (
                    <button
                      type="button"
                      className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                      onClick={() => onDeselectTurn(issue.productTurnId!)}
                    >
                      {intl.formatMessage({
                        id: "conversationShare.issue.deselectTurn",
                      })}
                    </button>
                  ) : null}
                  {blockingIssues.includes(issue) &&
                  issue.scope === "transport" &&
                  onRetryPreflight ? (
                    <button
                      type="button"
                      data-testid="conversation-share-preflight-retry"
                      className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                      onClick={onRetryPreflight}
                    >
                      {intl.formatMessage({
                        id: "conversationShare.issue.retryPreflight",
                      })}
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </PopoverContent>
      </Popover>
    </section>
  );
}

export const ConversationSharePreflightStatus = memo(ConversationSharePreflightStatusImpl);
