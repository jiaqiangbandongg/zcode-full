import { useEffect, useState } from "react";
import type { BotContextState } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useBotGroupMemberNames(context: BotContextState | null) {
  const { botsService } = useServices();
  const botId = context?.botId;
  const chatId = context?.group?.chatId;
  const authorizationId = context?.group?.authorizationId;
  const enabled = context?.group?.enabled;
  const key = JSON.stringify([botId, chatId, authorizationId, enabled]);
  const [resolved, setResolved] = useState<{ key: string; names: Record<string, string> } | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    let loading = false;
    setResolved(null);
    const refresh = async () => {
      if (loading || !botId || !chatId || !enabled || !botsService.getGroupMemberNames) return;
      loading = true;
      try {
        const names = await botsService.getGroupMemberNames({ botId, chatId });
        if (!disposed) setResolved({ key, names });
      } catch (error) {
        if (!disposed) {
          setResolved(null);
          logger.debug("读取群成员姓名失败", { error: String(error) });
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [botsService, botId, chatId, enabled, key]);
  // 切换群或授权后立即隐藏旧缓存，不等 effect 清理完成。
  return botId && chatId && enabled && resolved?.key === key
    ? { botId, chatId, names: resolved.names }
    : null;
}
