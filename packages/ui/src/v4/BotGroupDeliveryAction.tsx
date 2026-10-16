import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { useContext, useMemo, type ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import type { BotGroupDelivery } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBotGroupTask } from "@/hooks/useBotGroupTask.js";

import { useBotGroupMemberNames } from "@/hooks/useBotGroupMemberNames.js";
import { BotGroupMemberNamesContext } from "@/v4/BotGroupMemberNamesContext.js";

export function BotGroupDeliveryProvider({
  taskId,
  workspacePath,
  workspaceIdentity,
  children,
}: {
  taskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}) {
  // 同一任务只订阅一次群状态，历史回复不各自请求全量 Bot 状态。
  const { context, provider, busyId, retry, reconcile, retryPreparation } = useBotGroupTask(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  const memberNames = useBotGroupMemberNames(context);
  const value = useMemo(
    () => ({
      context,
      provider,
      busyId,
      retry,
      reconcile,
      retryPreparation,
      taskId,
    }),
    [context, provider, busyId, retry, reconcile, retryPreparation, taskId],
  );
  return (
    <DeliveryContext.Provider value={value}>
      <BotGroupMemberNamesContext.Provider value={memberNames}>
        {children}
      </BotGroupMemberNamesContext.Provider>
    </DeliveryContext.Provider>
  );
}

export function BotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
  syncing,
  results,
  busyId,
  onRetry,
  onReconcile,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
  syncing: boolean;
  results: BotGroupDelivery[];
  busyId?: string | null;
  onRetry: (id: string) => void;
  onReconcile: (id: string, received: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // Bug 原因：任务级恢复面板与队列浮层重叠，还重复展示正文；只在已关联轮次的操作栏展示。
  const unresolved = results.filter(
    (result) =>
      result.sourceCommandId &&
      sourceCommandIds.includes(result.sourceCommandId) &&
      (result.status === "failed" || result.status === "unknown"),
  );
  if (!unresolved.length) return null;
  const label = intl.formatMessage({
    id: unresolved.some((result) => result.status === "unknown")
      ? "bots.group.deliveryUnknown"
      : "bots.group.deliveryFailed",
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-warning"
          aria-label={label}
          title={label}
          data-bot-group-delivery={turnId}
        >
          <CircleAlertIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-w-[calc(100vw-2rem)] gap-2"
        data-bot-group-delivery-actions={turnId}
      >
        {unresolved.map((result, index) => (
          <div key={result.id} className="flex flex-col gap-1">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({
                id:
                  result.status === "unknown"
                    ? "bots.group.deliveryUnknown"
                    : "bots.group.deliveryFailed",
              })}
              {unresolved.length > 1 ? ` (${index + 1}/${unresolved.length})` : null}
            </span>
            {syncing ? (
              <div className="flex flex-wrap gap-1">
                {result.status === "unknown" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, true)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmReceived" })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, false)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmNotReceived" })}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busyId === result.id}
                    onClick={() => onRetry(result.id)}
                  >
                    {intl.formatMessage({ id: "bots.group.resend" })}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function ConnectedBotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
}) {
  const value = useContext(DeliveryContext);
  const context = value?.context;
  if (!value || !context?.group) return null;
  return (
    <BotGroupDeliveryAction
      turnId={turnId}
      sourceCommandIds={sourceCommandIds}
      syncing={context.group.enabled && context.activeTaskId === value.taskId}
      results={Object.values(context.group.deliveries ?? {}).filter(
        (result) => result.taskId === value.taskId,
      )}
      busyId={value.busyId}
      onRetry={(id) => {
        void value.retry(id);
      }}
      onReconcile={(id, received) => {
        void value.reconcile(id, received);
      }}
    />
  );
}
