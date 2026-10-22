import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type { FeedbackTicketStatus } from "@zcode/shared";
import { formatFeedbackStatusLabel, STATUS_META } from "@/feedback/feedbackMeta.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RequiredMarker() {
  // 两个反馈弹窗曾各自维护星号，导致读屏语义分叉；统一隐藏装饰符号，必填由输入框声明。
  return (
    <span aria-hidden="true" className="mr-1 text-destructive">
      *
    </span>
  );
}

export function StatusIndicator({
  status,
  withDot = true,
  children,
  className,
}: {
  status: FeedbackTicketStatus;
  withDot?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const meta = STATUS_META[status];
  const { intl } = useZCodeIntl();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-ui-base font-medium",
        meta.className,
        className,
      )}
    >
      {withDot ? <span className={cn("size-1.5 rounded-full", meta.dot)} /> : null}
      {children ?? formatFeedbackStatusLabel(status, intl.formatMessage)}
    </span>
  );
}

export function FeedbackErrorTip({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-ui-base text-red-300"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" />
      <span className="break-words leading-relaxed">{message}</span>
    </div>
  );
}
