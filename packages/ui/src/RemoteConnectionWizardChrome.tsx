import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import { TID_REMOTE_NEW_CONNECTION_PREVIEW } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteConnectionKindTag } from "@/remote-connection/RemoteConnectionTags.js";

export type RemoteWizardStep = "device" | "settings" | "connecting" | "directory";

/** 表单屏头部的实时预览：target 为空时显示该类型的占位。 */
export interface RemoteSettingsPreview {
  kind: RemoteTarget["kind"];
  target: string | null;
}

/**
 * 表单是选择屏的子视图，不把尚未选择设备的首屏画成已完成。
 * 设置入口（设备管理）不显示步骤条：只有表单与进度两屏，进度页自带标题（RDUX-27）。
 */
export function RemoteConnectionWizardSidebar({
  currentStep,
  deviceManagement,
}: {
  currentStep: RemoteWizardStep;
  deviceManagement?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (deviceManagement) return null;
  const currentIndex = currentStep === "directory" ? 2 : currentStep === "connecting" ? 1 : 0;
  return (
    <nav aria-label={intl.formatMessage({ id: "remote.wizard" })}>
      <ol className="flex items-center gap-2 text-ui-sm">
        {["remote.selection.step", "remote.selection.connect", "remote.step.directory"].map(
          (id, index) => (
            <li
              key={id}
              aria-current={index === currentIndex ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2",
                index === currentIndex
                  ? "font-medium text-foreground"
                  : "text-remote-foreground-muted",
              )}
            >
              {index > 0 ? <span className="h-px w-5 bg-border" /> : null}
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-md border text-ui-xs",
                  index === currentIndex && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {index < currentIndex ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span>{intl.formatMessage({ id })}</span>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

function SettingsPreviewText({ preview }: { preview: RemoteSettingsPreview }) {
  const { intl } = useZCodeIntl();
  const placeholder =
    preview.kind === "ssh"
      ? "user@host:22"
      : intl.formatMessage({
          id:
            preview.kind === "docker"
              ? "docker.selectContainer"
              : preview.kind === "wsl"
                ? "wsl.defaultDistro"
                : "server.urlPlaceholder",
        });
  return (
    <DialogDescription
      data-testid={TID_REMOTE_NEW_CONNECTION_PREVIEW}
      className={cn(
        "break-all font-mono text-ui-sm",
        preview.target ? "text-remote-foreground-muted" : "text-foreground-subtlest",
      )}
    >
      {preview.target ?? placeholder}
    </DialogDescription>
  );
}

export function RemoteConnectionWizardHeader({
  currentStep,
  title,
  description,
  settingsPreview,
  onMinimize,
  onClose,
  hideHeading = false,
  deviceManagement,
}: {
  currentStep: RemoteWizardStep;
  title: string;
  description: string;
  settingsPreview?: RemoteSettingsPreview;
  onMinimize?: () => void;
  onClose?: () => void;
  hideHeading?: boolean;
  deviceManagement?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {onMinimize ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          title={intl.formatMessage({ id: "remote.minimize" })}
          onClick={onMinimize}
        >
          <MinusIcon className="size-4" />
          <span className="sr-only">{intl.formatMessage({ id: "remote.minimize" })}</span>
        </Button>
      ) : null}
      {onClose ? (
        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onClick={onClose}>
          <XIcon className="size-4" />
          <span className="sr-only">{intl.formatMessage({ id: "common.close" })}</span>
        </Button>
      ) : null}
    </div>
  );
  // 设置入口的类型切换已表达类型，只有项目/聊天入口在标题旁显示类型标签。
  const showKindTag = !deviceManagement && settingsPreview != null;
  const heading = (
    <div
      className={cn(
        "min-w-0",
        hideHeading ? "sr-only" : settingsPreview ? "space-y-1.5" : "space-y-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DialogTitle className="text-ui-lg font-medium">{title}</DialogTitle>
        {showKindTag && settingsPreview.kind !== "server" ? (
          <RemoteConnectionKindTag kind={settingsPreview.kind} />
        ) : null}
      </div>
      {settingsPreview ? (
        <SettingsPreviewText preview={settingsPreview} />
      ) : (
        <DialogDescription className="text-pretty text-remote-foreground-muted">
          {description}
        </DialogDescription>
      )}
    </div>
  );

  if (deviceManagement) {
    return (
      <div className="flex items-start justify-between gap-4">
        {heading}
        {controls}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <RemoteConnectionWizardSidebar currentStep={currentStep} />
        {controls}
      </div>
      {heading}
    </div>
  );
}
