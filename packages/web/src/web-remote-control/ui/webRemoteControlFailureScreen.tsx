import { Button } from "@zcode/ui/button";
import type { WebRemoteControlFailure } from "@zcode/shared";
import { WebRemoteControlSwitchAccountDialog } from "#src/web-remote-control/ui/webRemoteControlSwitchAccountDialog.js";

import {
  resolveWebRemoteControlScreenCopy,
  type WebRemoteControlScreenLocale,
  type WebRemoteControlScreenCopy,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
export {
  resolveWebRemoteControlScreenCopy,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

function resolveToneClassName(tone: WebRemoteControlScreenCopy["tone"]): {
  badge: string;
  icon: string;
} {
  switch (tone) {
    case "danger":
      return {
        badge: "border-destructive/30 bg-destructive/10 text-destructive",
        icon: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    case "warning":
      return {
        badge: "border-warning/30 bg-warning/10 text-foreground",
        icon: "border-warning/30 bg-warning/10 text-warning",
      };
    default:
      return {
        badge: "border-border bg-surface text-foreground-subtle",
        icon: "border-border bg-surface text-foreground-subtle",
      };
  }
}

interface WebRemoteControlFailureScreenProps {
  failure: WebRemoteControlFailure;
  locale: WebRemoteControlScreenLocale;
  onReload(): void;
  primaryActionLabel?: string;
  secondaryAction?: { label: string; onClick(): void };
}

export function WebRemoteControlFailureScreen({
  failure,
  locale,
  onReload,
  primaryActionLabel,
  secondaryAction,
}: WebRemoteControlFailureScreenProps) {
  const copy = resolveWebRemoteControlScreenCopy(failure, locale);
  const toneClassName = resolveToneClassName(copy.tone);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground"
      style={{ minHeight: "100dvh" }}
    >
      <main className="w-full max-w-md rounded-xl border border-card-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg border text-ui-lg font-semibold ${toneClassName.icon}`}
            aria-hidden="true"
          >
            !
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`mb-2 inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-ui-xs font-medium ${toneClassName.badge}`}
            >
              <span className="min-w-0 truncate">{copy.badge}</span>
            </div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.title}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">{copy.description}</p>
          </div>
        </div>

        <section className="mt-5 border-t border-border pt-4">
          <h2 className="text-ui-xs font-medium text-foreground">{copy.nextStepsTitle}</h2>
          <ol className="mt-2 space-y-2 text-ui-xs leading-6 text-foreground-subtle">
            {copy.nextSteps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-ui-xs text-foreground-subtle">
                  {index + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {failure.message ? (
          <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2.5">
            <div className="text-ui-xs font-medium text-foreground">{copy.detailLabel}</div>
            <div className="mt-1 break-words font-mono text-ui-xs leading-5 text-foreground-subtle">
              {failure.message}
            </div>
          </section>
        ) : null}

        {failure.reason === "device-not-owned" ? (
          <WebRemoteControlSwitchAccountDialog locale={locale} onConfirm={onReload}>
            <Button type="button" className="mt-5 w-full">
              {primaryActionLabel ?? copy.action}
            </Button>
          </WebRemoteControlSwitchAccountDialog>
        ) : (
          <Button type="button" className="mt-5 w-full" onClick={onReload}>
            {primaryActionLabel ?? copy.action}
          </Button>
        )}
        {secondaryAction ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full"
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
      </main>
    </div>
  );
}
