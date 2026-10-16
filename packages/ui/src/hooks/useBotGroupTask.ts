import { useCallback, useEffect, useState } from "react";
import { isFeishuBotProvider, type BotContextState, type FeishuBotProvider } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useBotGroupTask(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const { botsService, broadcastService } = useServices();
  const [context, setContext] = useState<BotContextState | null>(null);
  const [provider, setProvider] = useState<FeishuBotProvider>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const requested = ++revision;
      if (!taskId) {
        setContext(null);
        return;
      }
      try {
        const states = await botsService.getBotStates();
        if (disposed || revision !== requested) return;
        const nextContext =
          states.find(
            (state) =>
              (state.group?.taskWorkspaces?.[taskId]?.workspaceIdentity?.trim() ||
                state.group?.taskWorkspaces?.[taskId]?.workspacePath ||
                state.workspaceIdentity?.trim() ||
                state.workspacePath) === workspaceKey && state.group?.taskIds.includes(taskId),
          ) ?? null;
        setContext(nextContext);
        const savedProvider = Object.values(nextContext?.group?.inputs ?? {})[0]?.source.provider;
        setProvider(savedProvider);
        if (nextContext && !savedProvider) {
          // 首次准备还没有 accepted source，渠道名称取当前机器人配置，不默认猜作飞书。
          const config = await botsService.getConfig();
          if (disposed || revision !== requested) return;
          const configured = config.bots.find((bot) => bot.id === nextContext.botId)?.provider;
          setProvider(configured && isFeishuBotProvider(configured) ? configured : undefined);
        }
      } catch (error) {
        if (!disposed) logger.warn("读取群任务同步状态失败", { error: String(error) });
      }
    };
    setContext(null);
    setProvider(undefined);
    void refresh();
    const subscription = broadcastService.onMessage((message) => {
      if (message.channel === "bots:group-state") void refresh();
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [botsService, broadcastService, taskId, workspaceKey]);
  const retry = useCallback(
    async (deliveryId: string) => {
      if (!context?.group || !botsService.resendGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.resendGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("重发群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  const reconcile = useCallback(
    async (deliveryId: string, received: boolean) => {
      if (!context?.group || !botsService.reconcileGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.reconcileGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
          received,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("核对群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  const retryPreparation = useCallback(
    async (messageId: string) => {
      if (!context?.group?.threadId || !taskId || !botsService.retryTopicPreparation) return;
      setBusyId(messageId);
      try {
        await botsService.retryTopicPreparation({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          taskId,
          workspacePath,
          workspaceIdentity,
          messageId,
        });
      } catch (error) {
        logger.warn("重试话题材料失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context, taskId, workspacePath, workspaceIdentity],
  );
  return { context, provider, busyId, retry, reconcile, retryPreparation };
}
