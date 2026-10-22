import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import { usePublishRemoteConnectionProgress } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { useEffect, useRef, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared/test-ids";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useRemoteConnectionFlow,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/index.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import { RemoteConnectionWizardHeader } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogProps extends RemoteConnectionFlowOptions {
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  hideTriggerWhenClosed?: boolean;
  allowBackground?: boolean;
}

export function RemoteConnectionDialog(props: RemoteConnectionDialogProps) {
  const {
    trigger,
    triggerVariant = "outline",
    triggerSize = "sm",
    triggerClassName,
    hideTriggerWhenClosed = false,
    allowBackground = true,
  } = props;
  const { intl } = useZCodeIntl();
  const flow = useRemoteConnectionFlow(props);
  const { open, currentStep, error, handleOpenChange } = flow;
  usePublishRemoteConnectionProgress(flow.minimizedProgress);
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // 优先保留凭据等待点主动聚焦的字段；否则焦点随新屏移动。
    if (screenRef.current?.contains(document.activeElement)) return;
    screenRef.current
      ?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')
      ?.focus();
  }, [open, currentStep]);

  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => flow.handleOpenChange(true)}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* 上边缘固定在视口 10% 处，切换类型或认证方式时只向下伸缩，不再上下跳（RDUX-27）。 */}
        <DialogContent
          showCloseButton={false}
          className="top-[10vh] flex max-h-[calc(90dvh-1rem)] w-[calc(100vw-2rem)] max-w-2xl translate-y-0 flex-col overflow-hidden rounded-2xl p-0"
        >
          <div data-testid={TID_SSH_DIALOG} className="flex min-h-0 flex-col overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  {...flow.header}
                  onMinimize={allowBackground ? flow.header.onMinimize : undefined}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // 远程连接的错误提示以前直接拼接颜色 token，和全局状态反馈样式不一致。
                  // 这里统一改成 destructive 语义色对，避免 SSH/Docker 两种模式出现不同的错误视觉。
                  className="flex items-start gap-3 rounded-md bg-destructive-surface px-3 py-3 text-ui-sm text-destructive-surface-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div ref={screenRef} className="flex w-full min-h-0 flex-col">
                {currentStep === "device" ? (
                  <RemoteConnectionSelection {...flow.selectionStep} />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep {...flow.settingsStep} />
                ) : null}

                {currentStep === "connecting" ? (
                  <RemoteConnectionConnectingStep
                    {...flow.connectingStep}
                    onMinimize={allowBackground ? flow.connectingStep.onMinimize : undefined}
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="flex min-h-0 flex-col">
                    <RemoteConnectionDirectoryStep {...flow.directoryStep} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;
