import type { CodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import type { CodingPlanQuotaResetUiController } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { findCodingPlanQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";

export function resolveChatCodingPlanResetOpportunityBadge(
  state: CodingPlanUsageRemainingState | null,
  resetUi: Pick<CodingPlanQuotaResetUiController, "entry" | "opportunityVisible" | "week">,
) {
  const limits = state?.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );

  // Bugfix：徽标曾在额度剩余 100% 时隐藏（重置无收益）。但核销会把剩余改写成 100%，
  // 余下机会的徽标随即消失，用户以为卡被吞掉。只要该额度存在且有可用机会就展示张数。
  return mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(fiveHourTokenLimit) && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(weeklyTokenLimit) && resetUi.week.opportunityVisible,
    },
  ]);
}
