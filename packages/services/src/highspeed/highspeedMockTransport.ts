import type {
  HighspeedCardUsage,
  HighspeedDrawResponse,
  HighspeedMockScenario,
} from "@zcode/shared";
import type { HighspeedServiceTransport } from "./highspeedCardService.js";

const MOCK_DRAW_COOLDOWN_MS = 2 * 60_000;
const MOCK_CARD_LIFETIME_MS = 5 * 60_000;

export function createHighspeedMockTransport(options?: {
  scenario?: HighspeedMockScenario;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}): HighspeedServiceTransport {
  const scenario = options?.scenario ?? "hit-fast";
  const now = options?.now ?? Date.now;
  const delay =
    options?.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async draw(request): Promise<HighspeedDrawResponse> {
      if (scenario === "hit-after-timeout") await delay(1200);
      else await delay(80);
      const current = now();
      if (scenario === "miss") {
        return {
          code: 0,
          msg: "success",
          data: { card: null, next_draw_at: current + MOCK_DRAW_COOLDOWN_MS },
        };
      }
      const taskId =
        scenario === "existing-foreign-task-card" ? "mock-foreign-task" : request.task_id;
      const expiresAt =
        scenario === "expired-card" ? current - 1 : current + MOCK_CARD_LIFETIME_MS;
      return {
        code: 0,
        msg: "success",
        data: {
          card: {
            card_id: `hsc_mock_${current}`,
            task_id: taskId,
            provider: request.provider,
            model: request.model,
            issued_at: current,
            expires_at: expiresAt,
          },
          next_draw_at: current + MOCK_DRAW_COOLDOWN_MS,
        },
      };
    },
    async healthy(cardId): Promise<HighspeedCardUsage> {
      return {
        cardId,
        promptTokens: 12_000,
        completionTokens: 8_000,
        durationSeconds: 90,
      };
    },
  };
}
