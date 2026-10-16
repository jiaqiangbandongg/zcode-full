import { ChevronLeft, Clock3, ListChecks } from "lucide-react";
import type { FeedbackTicketDetail } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { FeedbackProgress } from "@/feedback/feedbackProgress.js";
import { FeedbackSupplementComposer } from "@/feedback/FeedbackSupplementComposer.js";
import { FeedbackTimeline, getFeedbackTimelineItems } from "@/feedback/feedbackTimeline.js";
import { formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeedbackProcessView({
  ticket,
  feedbackService,
  onBack,
  onRefresh,
}: {
  ticket: FeedbackTicketDetail;
  feedbackService: IFeedbackService;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const timelineItems = getFeedbackTimelineItems(ticket.events ?? [], ticket.comments, formatMessage);
  const latestItem = timelineItems.at(-1);

  return (
    <div className="flex min-h-full flex-col gap-5">
      <header className="shrink-0">
        <div className="mb-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onBack}
            className="h-8 rounded-lg text-foreground-subtle hover:bg-hover hover:text-foreground"
          >
            <ChevronLeft />
            {formatMessage({ id: "feedback.process.backToDetail" })}
          </Button>
        </div>
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-ui-base font-medium text-foreground-subtle">
                <ListChecks className="size-3.5" />
                {formatMessage({ id: "feedback.process.title" })}
              </div>
              <h2 className="mt-2 line-clamp-2 text-ui-lg font-semibold text-foreground">
                {ticket.title}
              </h2>
            </div>
            <div className="shrink-0 rounded-full border border-border bg-surface px-2.5 py-1 text-ui-base text-foreground-subtle">
              {formatMessage(
                { id: "feedback.timeline.stepCount" },
                { count: String(timelineItems.length) },
              )}
            </div>
          </div>
          <div className="mt-4">
            <FeedbackProgress status={ticket.status} assigneeDisplay={ticket.assignee_display} />
          </div>
          {latestItem ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
              <Clock3 className="size-3.5 text-primary" />
              <span className="text-foreground-subtle">
                {formatMessage({ id: "feedback.process.currentLatest" })}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {latestItem.summary ??
                  (latestItem.isStaff
                    ? formatMessage({ id: "feedback.timeline.officialReply" })
                    : formatMessage({ id: "feedback.timeline.yourSupplement" }))}
              </span>
              <span className="shrink-0 text-foreground-subtle">
                {formatRelativeTime(latestItem.createdAt, formatMessage)}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <section className="rounded-lg border border-card-border bg-card p-4">
        <FeedbackTimeline events={ticket.events ?? []} comments={ticket.comments} showDurations />
      </section>

      <FeedbackSupplementComposer
        ticketId={ticket.id}
        feedbackService={feedbackService}
        onSubmitted={onRefresh}
        title={formatMessage({ id: "feedback.supplement.continueTitle" })}
        description={formatMessage({ id: "feedback.supplement.continueDescription" })}
      />
    </div>
  );
}
