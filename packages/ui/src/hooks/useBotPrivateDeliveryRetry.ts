import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";

export function useBotPrivateDeliveryRetry(botId: string, deliveryId: string) {
  const { botsService } = useServices();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    ++generation.current;
    busy.current = false;
    setState("idle");
    return () => {
      ++generation.current;
    };
  }, [botId, deliveryId]);
  const retry = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const current = generation.current;
    setState("sending");
    try {
      if (!botsService.retryPrivateDelivery) throw new Error("Delivery retry unavailable");
      await botsService.retryPrivateDelivery({ botId, deliveryId });
      if (generation.current === current) setState("done");
    } catch {
      if (generation.current === current) setState("error");
    } finally {
      if (generation.current === current) busy.current = false;
    }
  }, [botId, deliveryId, botsService]);
  return { state, retry };
}
