import { LaptopIcon, ServerIcon } from "lucide-react";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SourceServerBoundaryDialogContent({
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  title?: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="grid sm:grid-cols-5">
      <div className="flex min-h-40 flex-col justify-center gap-5 bg-[var(--color-remote-continuity-panel)] p-6 text-[var(--color-remote-continuity-panel-foreground)] sm:col-span-2 sm:min-h-72">
        <div
          data-testid="source-server-boundary-local"
          className="flex items-center gap-3 text-[var(--color-remote-continuity-panel-subtle)]"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-remote-continuity-panel-surface)]">
            <LaptopIcon className="size-5" />
          </span>
          <span className="min-w-0">
            <strong className="block text-ui-base font-medium">
              {intl.formatMessage({ id: "remote.sourceServerBoundaryLocalDevice" })}
            </strong>
            <span className="block text-ui-sm">
              {intl.formatMessage({ id: "remote.sourceServerBoundaryLocalStatus" })}
            </span>
          </span>
        </div>

        <div data-testid="source-server-boundary-remote" className="flex items-center gap-3">
          <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-success-surface text-success-surface-foreground">
            <ServerIcon className="size-5" />
            <span className="absolute -right-0.5 -top-0.5 flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-40 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2.5 rounded-full bg-success" />
            </span>
          </span>
          <span className="min-w-0">
            <strong className="block text-ui-base font-medium">
              {intl.formatMessage({ id: "remote.sourceServerBoundaryRemoteTask" })}
            </strong>
            <span className="block text-ui-sm text-success-surface-foreground">
              {intl.formatMessage({ id: "remote.sourceServerBoundaryRemoteStatus" })}
            </span>
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-col justify-center p-6 sm:col-span-3 sm:p-8">
        <div className="mb-4 flex items-center gap-2 text-ui-sm font-medium text-success">
          <span className="size-2 rounded-full bg-success" />
          {intl.formatMessage({ id: "remote.sourceServerBoundaryEyebrow" })}
        </div>
        <DialogTitle className="text-ui-xl font-semibold text-foreground">{title}</DialogTitle>
        {description ? (
          // 中文自然折行会留下孤立尾字，保留文案中的语义换行；英文随可用宽度均衡折行。
          <DialogDescription className="mt-2 whitespace-pre-line text-balance text-ui-base leading-6 text-foreground-subtle">
            {description}
          </DialogDescription>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            autoFocus
            size="lg"
            data-testid={TID_CONFIRM_DIALOG_CONFIRM}
            onClick={onConfirm}
            className="h-9 min-w-28 px-5"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
