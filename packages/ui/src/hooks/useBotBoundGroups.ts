import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotConfig, BotState } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface BoundGroupRow {
  chatId: string;
  name: string;
  enabled: boolean;
  topicCount: number;
}

export function projectBoundGroups(
  states: BotState[],
  botId: string,
  ownerId?: string,
): BoundGroupRow[] {
  if (!ownerId) return [];
  const groups = states.filter(
    (state) => state.botId === botId && state.group?.ownerId === ownerId,
  );
  return groups
    .filter((state) => !state.group!.threadId)
    .map(({ group }) => ({
      chatId: group!.chatId,
      name: group!.name,
      enabled: group!.enabled,
      topicCount: new Set(
        groups
          .filter((state) => state.group!.chatId === group!.chatId)
          .map((state) => state.group!.threadId)
          .filter(Boolean),
      ).size,
    }));
}

export function useBotBoundGroups(bot: BotConfig) {
  const { botsService, broadcastService } = useServices();
  const [states, setStates] = useState<BotState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const savingRef = useRef(false);
  const refresh = useCallback(async () => {
    const requested = ++revision.current;
    const next = await botsService.getBotStates();
    if (alive.current && requested === revision.current) {
      setStates(next);
      setLoading(false);
    }
    return next;
  }, [botsService]);
  const reload = useCallback(async () => {
    const requested = revision.current + 1;
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      // 迟到的失败不能覆盖广播触发的新读取结果。
      if (!alive.current || requested !== revision.current) return;
      logger.warn("读取已绑定群聊失败", { error: String(cause) });
      setError("load");
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const subscription = broadcastService.onMessage((message) => {
      if (message.channel === "bots:group-state") void reload();
    });
    return () => {
      alive.current = false;
      ++revision.current;
      subscription.dispose();
    };
  }, [broadcastService, reload]);
  const toggle = useCallback(
    async (chatId: string, enabled: boolean) => {
      if (savingRef.current || !bot.enabled || !botsService.setGroupEnabled) return;
      savingRef.current = true;
      setSaving(chatId);
      setError(null);
      try {
        await botsService.setGroupEnabled({ botId: bot.id, chatId, enabled });
        const next = await refresh();
        // 旧接口可能返回成功但未改变授权，必须读取权威状态再确认。
        const actual = projectBoundGroups(next, bot.id, bot.providerUserId).find(
          (row) => row.chatId === chatId,
        );
        if (actual?.enabled !== enabled) throw new Error("Group authorization was not updated");
      } catch (cause) {
        if (alive.current) {
          logger.warn("保存群聊开关失败", { error: String(cause) });
          setError("save");
        }
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(null);
      }
    },
    [bot.enabled, bot.id, bot.providerUserId, botsService, refresh],
  );
  const rows = useMemo(
    () => projectBoundGroups(states, bot.id, bot.providerUserId),
    [states, bot.id, bot.providerUserId],
  );
  return {
    rows,
    loading,
    error,
    saving,
    reload,
    toggle,
    supported: Boolean(botsService.setGroupEnabled),
  };
}
