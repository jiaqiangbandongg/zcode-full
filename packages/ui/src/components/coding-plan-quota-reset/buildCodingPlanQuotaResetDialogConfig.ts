import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetDialogConfig,
  CodingPlanQuotaResetDialogResetItem,
  CodingPlanQuotaResetDialogUsageItem,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import type { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { CodingPlanQuotaResetUiEntry } from "@/lib/codingPlanQuotaResetUi.js";

type CodingPlanQuotaResetUi = ReturnType<typeof useCodingPlanQuotaResetUi>;

function createResetItem(params: {
  enabled: boolean;
  entry: CodingPlanQuotaResetUiEntry | null;
  onReset: () => Promise<void>;
  opportunityVisible: boolean;
  processing: boolean;
  resetType: CodingPlanResetType;
}): CodingPlanQuotaResetDialogResetItem | null {
  const { enabled, entry, opportunityVisible, processing } = params;
  // Bugfix：这里曾额外用「额度剩余 100% 则重置无收益」门控隐藏整行。但核销会把剩余额度
  // 改写成 100%，同类型仍有余下机会时 entry 会回到 available，于是刚做的重置把余下的卡
  // 一起藏掉，用户以为机会丢失。机会是用户资产，只要 opportunityVisible（有未过期的
  // 可用张数）就展示，满额时是否核销交由用户判断。
  if (!enabled || !entry || (!processing && entry.status !== "completed" && !opportunityVisible)) {
    return null;
  }
  return {
    count: entry.opportunityCount,
    expiresAt: entry.opportunityExpiresAt,
    onReset: params.onReset,
    processing,
    resetType: params.resetType,
  };
}

export function buildCodingPlanQuotaResetDialogConfig(params: {
  fiveHourEnabled: boolean;
  resetUi: CodingPlanQuotaResetUi;
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
  weekEnabled: boolean;
}): CodingPlanQuotaResetDialogConfig {
  const { resetUi } = params;
  const resetItems = [
    createResetItem({
      enabled: params.fiveHourEnabled,
      entry: resetUi.entry,
      onReset: resetUi.reset,
      opportunityVisible: resetUi.opportunityVisible,
      processing: resetUi.processing,
      resetType: "FIVE_HOUR",
    }),
    createResetItem({
      enabled: params.weekEnabled,
      entry: resetUi.week.entry,
      onReset: resetUi.week.reset,
      opportunityVisible: resetUi.week.opportunityVisible,
      processing: resetUi.week.processing,
      resetType: "WEEK",
    }),
  ].filter((item): item is CodingPlanQuotaResetDialogResetItem => item !== null);
  return { resetItems, usageItems: params.usageItems };
}
