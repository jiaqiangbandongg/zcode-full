import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { SourceServerOperationLog } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function resolveUpdatePhaseMessageId(phase: string): string {
  if (phase === "probe" || phase === "preflight") {
    return "settings.source.updatePhase.checking";
  }
  if (phase === "download") return "settings.source.updatePhase.downloading";
  if (phase === "upload") return "settings.source.updatePhase.uploading";
  if (phase === "extract") return "remote.phaseSub.extracting";
  if (phase === "verify-archive") return "remote.phaseSub.verifyingArchive";
  if (phase === "verify") return "remote.phaseSub.verifyingFiles";
  if (phase === "restart") return "remote.phaseSub.restarting";
  if (phase === "install") return "settings.source.updatePhase.installing";
  if (phase === "daemon" || phase === "protocol-handshake") {
    return "settings.source.updatePhase.reconnecting";
  }
  if (phase === "ready") return "settings.source.updatePhase.completed";
  return "settings.source.updatePhase.preparing";
}

export function SourceServerUpdateActivity({
  active,
  logs,
  recent = false,
}: {
  active: boolean;
  recent?: boolean;
  logs: readonly SourceServerOperationLog[];
}) {
  const { intl, locale } = useZCodeIntl();
  const [expanded, setExpanded] = useState(active);
  const latest = logs.at(-1);
  const latestProgress = latest?.progress;
  const progressPercent =
    latestProgress === undefined ? undefined : Math.round(latestProgress * 100);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );

  useEffect(() => {
    if (active && logs.length > 0) setExpanded(true);
  }, [active, logs.length]);

  return (
    <div className="basis-full space-y-2 border-t border-border pt-2">
      {!recent ? (
        <>
          <div className="flex min-w-0 items-center gap-2 text-ui-xs">
            {active ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : null}
            <span className="min-w-0 flex-1 font-medium">
              {intl.formatMessage({
                id: resolveUpdatePhaseMessageId(latest?.phase ?? "update"),
              })}
            </span>
            {progressPercent !== undefined ? (
              <span className="shrink-0 tabular-nums">
                {numberFormatter.format(progressPercent)}%
              </span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={intl.formatMessage({ id: "settings.source.updateProgress" })}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progressPercent === undefined
              ? { "aria-busy": active }
              : { "aria-valuenow": progressPercent })}
            className="h-1 overflow-hidden rounded-full bg-surface"
          >
            <span
              className={cn(
                "block h-full rounded-full bg-progress-surface-foreground",
                progressPercent === undefined && active && "w-1/2 animate-pulse",
              )}
              style={progressPercent === undefined ? undefined : { width: `${progressPercent}%` }}
            />
          </div>
        </>
      ) : null}
      <Button
        data-source-server-log-toggle
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 px-0 text-current hover:bg-transparent"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        {intl.formatMessage(
          { id: recent ? "settings.source.recentLog" : "settings.source.updateLog" },
          { count: logs.length },
        )}
      </Button>
      {expanded ? <SourceServerLogList logs={logs} /> : null}
    </div>
  );
}

/** 最近日志列表；设备卡页脚与更新进度共用，展开状态由调用方持有。 */
export function SourceServerLogList({ logs }: { logs: readonly SourceServerOperationLog[] }) {
  const { intl, locale } = useZCodeIntl();
  return (
    <div
      data-source-server-log
      className="max-h-36 space-y-1 overflow-y-auto rounded-lg bg-surface px-3 py-2 font-mono text-ui-xs leading-5 text-foreground-subtle"
    >
      {logs.length > 0 ? (
        logs.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${entry.phase}-${index}`}
            className={cn(
              "flex min-w-0 gap-2",
              entry.level === "error" && "text-destructive",
              entry.level === "warn" && "text-warning",
            )}
          >
            <span
              data-source-server-log-timestamp
              className="shrink-0 text-remote-foreground-muted"
            >
              {new Date(entry.timestamp).toLocaleTimeString(locale, {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span className="min-w-0 break-words">{entry.message}</span>
          </div>
        ))
      ) : (
        <p>{intl.formatMessage({ id: "settings.source.updateLogWaiting" })}</p>
      )}
    </div>
  );
}
