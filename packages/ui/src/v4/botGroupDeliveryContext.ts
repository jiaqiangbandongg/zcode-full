import { createContext, useContext } from "react";
import type { useBotGroupTask } from "@/hooks/useBotGroupTask.js";

export const DeliveryContext = createContext<
  (ReturnType<typeof useBotGroupTask> & { taskId: string | null }) | null
>(null);

export function useBotTopicInterruption(sourceCommandIds: readonly string[]): boolean {
  const value = useContext(DeliveryContext);
  const group = value?.context?.group;
  return (
    !!group?.threadId &&
    sourceCommandIds.some((id) => {
      const input = group.inputs?.[id];
      return (
        input?.taskId === value?.taskId && input?.progress?.interruptionReason === "newMessage"
      );
    })
  );
}
