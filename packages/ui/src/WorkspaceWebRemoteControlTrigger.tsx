import { useState } from "react";
import { Smartphone } from "lucide-react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import {
  buildWebRemoteControlEntryViewTelemetry,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function getWebRemoteControlTriggerPresentation(
  status: Pick<WebRemoteControlStatus, "status" | "mobileConnected">,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  if (status.status === "error") {
    return {
      iconClassName: "text-destructive",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
    };
  }

  if (status.status === "active") {
    // Bugfix: relay 重连时 main 可能先把 status 降到 starting/running，
    // 但 mobileConnected 仍保留上一轮配对状态。按钮只按 active 显示已连接，
    // 避免和打开弹层后的真实连接阶段文案不一致。
    return {
      iconClassName: "text-success",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connected",
      }),
    };
  }

  if (status.status === "starting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.starting",
      }),
    };
  }

  if (status.status === "connecting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connecting",
      }),
    };
  }

  if (status.status === "running") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
    };
  }

  return {
    iconClassName: "text-foreground-subtle",
    tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
  };
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const enabled = useWebRemoteControlFeatureEnabled();

  // Bugfix: 生产默认隐藏时如果继续执行远程 session 解析 hook，会依赖 TabStoreProvider 并导致静态渲染提前抛错。
  // 这里先读无 store 依赖的 feature provider，再决定是否进入真正的入口内容。
  if (!enabled) {
    return null;
  }

  return (
    <WorkspaceWebRemoteControlTriggerContent
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      initialTaskId={initialTaskId}
      compact={compact}
      className={className}
    />
  );
}

function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mappedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // 修复原因：tab 上的 remoteSessionId 可能在断线重连期间失效；远控链路同时携带
  // identity 与 session，若继续透传未注册的旧值会组合成错误 endpoint。这里只采用
  // resolver 按 identity 校验后的 live session，未恢复时让弹层保持 remote-waiting。
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const remoteControlStatus = useWebRemoteControlStatus();
  const triggerPresentation = getWebRemoteControlTriggerPresentation(
    remoteControlStatus,
    intl.formatMessage,
  );

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={triggerPresentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            if (platform) {
              void reportAppTelemetryEvent(
                platform,
                buildWebRemoteControlEntryViewTelemetry({
                  workspaceKind:
                    workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
                  remoteKind: workspaceIdentity
                    ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
                    : undefined,
                }),
                "web-remote-control-entry",
              );
            }
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开 Web 远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
              remoteSessionId: currentRemoteSessionId ?? "none",
              initialTaskId: initialTaskId ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* Bugfix: 触发入口以前只显示固定手机图标，用户无法从桌面端判断手机是否已连上。
              这里复用远控状态轮询结果，用语义色表达连接状态，并把入口名称和状态文案合进同一个 tooltip，
              避免桌面端 footer 外层和按钮内层同时弹出两份提示。 */}
          <Smartphone className={cn("size-4", triggerPresentation.iconClassName)} />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={currentRemoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
}
