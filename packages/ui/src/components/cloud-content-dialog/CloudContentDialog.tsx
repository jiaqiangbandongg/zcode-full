import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { parseCloudDescriptionStyle } from "@/components/cloud-content-dialog/cloudDescriptionStyle.js";
import {
  CloudDialogDescription,
  CloudFormattedTextContent,
} from "@/components/cloud-content-dialog/CloudDialogDescription.js";
import { CloudDialogHero } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import type {
  CloudContentAction,
  CloudContentDialogPayload,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

export type CloudDialogActionHandlers = {
  [K in Exclude<CloudContentAction["type"], "close">]?: (
    action: Extract<CloudContentAction, { type: K }>,
    actionId?: string,
  ) => void | Promise<void>;
};

function dispatch(
  action: CloudContentAction,
  handlers: CloudDialogActionHandlers,
  actionId?: string,
) {
  switch (action.type) {
    case "close":
      return;
    case "copy_text":
      return handlers.copy_text?.(action);
    case "navigate":
      return handlers.navigate?.(action, actionId);
    case "open_external":
      return handlers.open_external?.(action);
    case "claim_plan":
      return handlers.claim_plan?.(action);
    case "dismiss_content":
      return handlers.dismiss_content?.(action);
  }
}

type CloudContentDialogProps = {
  payload: CloudContentDialogPayload;
  open: boolean;
  onClose: () => void;
  handlers: CloudDialogActionHandlers;
  labels: { actionFailed: string; copySucceeded?: string };
  actionPending?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function CloudContentDialog(props: CloudContentDialogProps) {
  return props.open ? (
    <CloudContentDialogInstance key={`${props.payload.id}:${props.payload.revision}`} {...props} />
  ) : null;
}

function CloudContentDialogInstance({
  payload,
  open,
  onClose,
  handlers,
  labels,
  actionPending = false,
  returnFocusRef,
}: CloudContentDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copiedActionId, setCopiedActionId] = useState<string>();
  useEffect(() => {
    if (!copiedActionId) return;
    const timer = setTimeout(() => setCopiedActionId(undefined), 2_000);
    return () => clearTimeout(timer);
  }, [copiedActionId]);
  const inFlight = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (action: CloudContentAction, actionId?: string) => {
    if (action.type === "close") {
      onClose();
      return;
    }
    if (actionPending || inFlight.current || !handlers[action.type]) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    try {
      await dispatch(action, handlers, actionId);
      if (mounted.current && action.type === "copy_text") setCopiedActionId(actionId);
      if (mounted.current && action.type === "dismiss_content") onClose();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        ref={content}
        data-testid="cloud-content-dialog"
        // macOS 窗口合成中，backdrop-filter 与隔离 iframe 叠加会在圆角外留下方形暗块；父层裁切无效。
        overlayClassName={
          payload.dialog.hero?.type === "interactive_bundle" ? "backdrop-filter-none!" : undefined
        }
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          // Radix 默认先聚焦 Hero iframe，跨文档的 Escape 不会冒泡到父弹窗。
          // 初始焦点留在关闭按钮；用户仍可用 Tab 或指针主动进入 Hero。
          if (payload.dialog.hero?.type === "interactive_bundle") {
            const close = content.current?.querySelector<HTMLButtonElement>(
              '[data-slot="dialog-close"]',
            );
            if (close) {
              event.preventDefault();
              close.focus();
            }
          }
        }}
        onCloseAutoFocus={(event) => {
          // 受控弹窗没有 Radix Trigger，默认关闭会丢失焦点；仅恢复仍在页面中的打开来源。
          event.preventDefault();
          const target = returnFocusRef?.current ?? opener.current;
          if (target?.isConnected) target.focus();
        }}
        // Hero 背景独立于 App 主题，关闭按钮用固定媒体覆盖层配色保证可见。
        className="cloud-content-dialog max-h-[calc(100dvh-2rem)] w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto border-0 p-0 [&_[data-slot=dialog-close]]:rounded-full"
      >
        {payload.dialog.hero ? (
          <div
            // Hero 与外壳共用顶部圆角，不依赖资源内容自行适配。
            className="aspect-[4/3] w-full overflow-hidden rounded-t-2xl bg-surface"
            data-testid="cloud-dialog-hero-slot"
          >
            <CloudDialogHero
              hero={payload.dialog.hero}
              locale={payload.locale}
              title={payload.dialog.title}
            />
          </div>
        ) : null}
        <section className="flex min-w-0 flex-col items-center gap-6 bg-popover px-6 py-7 text-center text-foreground">
          <div
            data-testid="cloud-dialog-status"
            className="flex w-full min-w-0 flex-col items-center gap-3"
          >
            <DialogTitle className="text-ui-xl font-semibold">
              <CloudFormattedTextContent
                inline
                text={
                  payload.dialog.formattedTitle ?? {
                    format: "plain_text",
                    text: payload.dialog.title,
                  }
                }
              />
            </DialogTitle>
            <DialogDescription asChild>
              <CloudDialogDescription
                data-testid="cloud-dialog-description"
                className="text-center text-ui-base/relaxed text-foreground-subtle"
                description={payload.dialog.description}
                onOpenExternal={
                  handlers.open_external
                    ? (url) => {
                        void run({ type: "open_external", url });
                      }
                    : undefined
                }
              />
            </DialogDescription>
          </div>
          {failed ? (
            <div role="alert" className="text-ui-sm text-destructive">
              {labels.actionFailed}
            </div>
          ) : null}
          <div className="flex w-full flex-wrap items-center justify-center gap-2">
            {payload.dialog.buttons.map((button) => {
              const action = Object.hasOwn(payload.actions, button.actionId)
                ? payload.actions[button.actionId]
                : undefined;
              const available =
                action && (action.type === "close" || Boolean(handlers[action.type]));
              return (
                <Button
                  key={button.id}
                  data-testid="cloud-dialog-action"
                  data-action-id={button.actionId}
                  size="lg"
                  className={cn(
                    "h-10 min-w-32 max-w-full whitespace-normal rounded-full px-6 text-ui-base",
                    button.theme?.class,
                  )}
                  style={parseCloudDescriptionStyle(button.theme?.style ?? null)}
                  variant={
                    button.theme?.variant ??
                    (button.variant === "primary" ? "default" : button.variant)
                  }
                  disabled={!available || ((pending || actionPending) && action?.type !== "close")}
                  onClick={() => {
                    if (action) void run(action, button.actionId);
                  }}
                >
                  {/* 动作类型不代表视觉语义，远端文案可能是“取消”；内容按钮统一不自动加图标。 */}
                  {copiedActionId === button.actionId && labels.copySucceeded ? (
                    labels.copySucceeded
                  ) : (
                    <span className="min-w-0 break-words">
                      <CloudFormattedTextContent
                        inline
                        text={button.formattedLabel ?? { format: "plain_text", text: button.label }}
                      />
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
