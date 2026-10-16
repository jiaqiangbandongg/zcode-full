import type {
  FeedbackComment,
  FeedbackCommentAttachment,
  FeedbackTicketEvent,
  FeedbackTicketEventType,
} from "@zcode/shared";
import {
  CheckCircle2,
  CornerDownRight,
  MessageSquare,
  Sparkle,
  UserCheck2,
  type LucideIcon,
} from "lucide-react";
import { filterUserVisibleComments, formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { getUserFacingEventSummary } from "@/feedback/feedbackTimelineSummary.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

interface FeedbackTimelineItem {
  id: string;
  kind: "event" | "reply";
  createdAt: string;
  // 事件
  type?: FeedbackTicketEventType;
  summary?: string;
  actor?: string | null;
  // 回复
  body?: string;
  attachments?: FeedbackCommentAttachment[];
  isStaff?: boolean;
}

const EVENT_ICON: Record<FeedbackTicketEventType, LucideIcon> = {
  created: Sparkle,
  status_changed: CheckCircle2,
  assignee_changed: UserCheck2,
  staff_replied: MessageSquare,
  user_replied: CornerDownRight,
};

export function getFeedbackTimelineItems(
  events: FeedbackTicketEvent[],
  comments: FeedbackComment[],
  formatMessage?: MessageFormatter,
): FeedbackTimelineItem[] {
  const visibleComments = filterUserVisibleComments(comments);
  // 用 comment_id 去重：如果事件里已经有 staff_replied/ user_replied 指向某条评论，
  // 评论就以事件形式呈现，不再额外加一条。
  const eventCommentIds = new Set<number>();
  for (const ev of events) {
    const payload = ev.payload as { comment_id?: number } | null | undefined;
    if ((ev.type === "staff_replied" || ev.type === "user_replied") && payload?.comment_id) {
      eventCommentIds.add(payload.comment_id);
    }
  }

  const items: FeedbackTimelineItem[] = [];

  for (const ev of events) {
    items.push({
      id: `event-${ev.id}`,
      kind: "event",
      createdAt: ev.created_at,
      type: ev.type,
      summary: getUserFacingEventSummary(ev, formatMessage),
      actor: getUserFacingEventActor(ev, formatMessage),
    });
    // 如果是回复事件，附带正文（从评论里查）
    const payload = ev.payload as { comment_id?: number } | null | undefined;
    if (payload?.comment_id) {
      const comment = visibleComments.find((c) => c.id === payload.comment_id);
      if (comment) {
        items[items.length - 1]!.body = comment.body;
        items[items.length - 1]!.attachments = comment.attachments ?? [];
        items[items.length - 1]!.isStaff = comment.is_staff;
      }
    }
  }

  // 兜底：评论里没有对应 event 的（旧数据）也展示
  for (const c of visibleComments) {
    if (eventCommentIds.has(c.id)) continue;
    items.push({
      id: `reply-${c.id}`,
      kind: "reply",
      createdAt: c.created_at,
      body: c.body,
      attachments: c.attachments ?? [],
      isStaff: c.is_staff,
      actor: c.is_staff
        ? formatOptionalMessage(formatMessage, "feedback.actor.productManager", "产品经理")
        : formatOptionalMessage(formatMessage, "feedback.actor.user", "用户"),
    });
  }

  return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function getUserFacingEventActor(
  event: FeedbackTicketEvent,
  formatMessage?: MessageFormatter,
) {
  switch (event.type) {
    case "created":
    case "user_replied":
      return formatOptionalMessage(formatMessage, "feedback.actor.user", "用户");
    case "assignee_changed":
      return formatOptionalMessage(
        formatMessage,
        "feedback.actor.productManager",
        "产品经理",
      );
    case "staff_replied":
      return formatOptionalMessage(
        formatMessage,
        "feedback.actor.productManager",
        "产品经理",
      );
    case "status_changed": {
      const payload = event.payload as { to?: unknown } | null | undefined;
      const toStatus = typeof payload?.to === "string" ? payload.to : "";
      return ["开发中", "已解决", "已上线"].includes(toStatus)
        ? formatOptionalMessage(formatMessage, "feedback.actor.dev", "研发")
        : formatOptionalMessage(
            formatMessage,
            "feedback.actor.productManager",
            "产品经理",
          );
    }
    default:
      return null;
  }
}

export function FeedbackTimeline({
  events,
  comments,
  showDurations = false,
}: {
  events: FeedbackTicketEvent[];
  comments: FeedbackComment[];
  showDurations?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const items = getFeedbackTimelineItems(events, comments, formatMessage);

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-center text-ui-base leading-6 text-foreground-subtle">
        {formatMessage({ id: "feedback.timeline.empty" })}
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 pl-5">
      <span className="absolute bottom-1 left-[7px] top-1 w-px bg-border" />
      {items.map((item, index) => {
        const Icon =
          item.kind === "event" && item.type
            ? EVENT_ICON[item.type]
            : item.isStaff
              ? MessageSquare
              : CornerDownRight;
        const isStaff = item.kind === "reply" ? item.isStaff : item.type === "staff_replied";
        const previousItem = index > 0 ? items[index - 1] : null;
        const durationLabel =
          showDurations && previousItem
            ? formatStepDuration(previousItem.createdAt, item.createdAt, formatMessage)
            : null;
        return (
          <li key={item.id} className="relative">
            <span
              className={cn(
                "absolute -left-5 top-0.5 flex size-4 items-center justify-center rounded-full ring-4 ring-card",
                isStaff
                  ? "bg-primary text-primary-foreground"
                  : item.type === "user_replied" || item.kind === "reply"
                    ? "bg-secondary text-foreground"
                    : "bg-success text-success-foreground",
              )}
            >
              <Icon className="size-2.5" />
            </span>
            <div className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-xs leading-5">
                <span className="font-medium text-foreground">
                  {item.summary ??
                    (item.isStaff
                      ? formatMessage({ id: "feedback.timeline.officialReply" })
                      : formatMessage({ id: "feedback.timeline.yourSupplement" }))}
                </span>
                {item.actor && item.kind === "event" ? (
                  <span className="text-foreground-subtle">· {item.actor}</span>
                ) : null}
                <span className="text-foreground-subtle">
                  · {formatRelativeTime(item.createdAt, formatMessage)}
                </span>
                {durationLabel ? (
                  <span className="rounded-full bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                    {formatMessage({ id: "feedback.timeline.duration" }, { time: durationLabel })}
                  </span>
                ) : null}
              </div>
              {item.body || item.attachments?.length ? (
                <div
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-ui-base leading-6",
                    isStaff
                      ? "border-primary/25 bg-accent text-foreground"
                      : "border-border bg-surface text-foreground",
                  )}
                >
                  {item.body ? <p className="whitespace-pre-wrap">{item.body}</p> : null}
                  {!!item.attachments?.length && (
                    <div className={cn("grid gap-2 sm:grid-cols-2", item.body ? "mt-2" : "")}>
                      {item.attachments.map((attachment) => {
                        const href = attachment.preview_url || attachment.download_url || undefined;
                        const isImage = isTimelineImageAttachment(attachment);
                        return (
                          <a
                            key={attachment.id}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-border-hover"
                          >
                            {isImage && href ? (
                              <img
                                src={href}
                                alt=""
                                className="max-h-40 w-full object-cover"
                              />
                            ) : (
                              <span className="block truncate px-3 py-2 text-ui-base text-foreground-subtle">
                                {attachment.filename}
                              </span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function isTimelineImageAttachment(attachment: FeedbackCommentAttachment) {
  if (attachment.content_type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.filename);
}

function formatStepDuration(from: string, to: string, formatMessage?: MessageFormatter) {
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return formatOptionalMessage(formatMessage, "feedback.duration.instant", "即时");
  }
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) {
    return formatOptionalMessage(formatMessage, "feedback.duration.lessThanMinute", "不到 1 分钟");
  }
  if (minutes < 60) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.duration.minutes",
      `${minutes} 分钟`,
      { count: String(minutes) },
    );
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.duration.hours",
      `${hours} 小时`,
      { count: String(hours) },
    );
  }
  const days = Math.round(hours / 24);
  return formatOptionalMessage(
    formatMessage,
    "feedback.duration.days",
    `${days} 天`,
    { count: String(days) },
  );
}

function formatOptionalMessage(
  formatMessage: MessageFormatter | undefined,
  id: string,
  fallback: string,
  values?: Record<string, string>,
) {
  return formatMessage ? formatMessage({ id }, values) : fallback;
}
