import { describe, expect, it } from "vitest";
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";
import type { CodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import type {
  CodingPlanQuotaResetTypeController,
  CodingPlanQuotaResetUiController,
} from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { CodingPlanQuotaResetUiEntry } from "@/lib/codingPlanQuotaResetUi.js";

const EXPIRES_AT = new Date("2026-08-13T10:20:00+08:00").getTime();

function createEntry(
  overrides: Partial<CodingPlanQuotaResetUiEntry> = {},
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount: 1,
    opportunityExpiresAt: EXPIRES_AT,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: null,
    error: null,
    ...overrides,
  };
}

function createTypeController(
  overrides: Partial<CodingPlanQuotaResetTypeController> = {},
): CodingPlanQuotaResetTypeController {
  return {
    entry: null,
    opportunityVisible: false,
    processing: false,
    done: false,
    statusVisible: false,
    reset: async () => undefined,
    ...overrides,
  };
}

function createController(params: {
  fiveHour?: Partial<CodingPlanQuotaResetTypeController>;
  week?: Partial<CodingPlanQuotaResetTypeController>;
}): CodingPlanQuotaResetUiController {
  return {
    ...createTypeController(params.fiveHour),
    enabled: true,
    week: createTypeController(params.week),
    reserveAutomaticCompletion: async () => ({ status: "blocked" }),
    commitAutomaticCompletion: () => false,
    releaseAutomaticCompletion: async () => undefined,
  };
}

/** percentage 是「已使用占比」：0 即剩余 100%，也就是重置刚把额度填满的状态。 */
function createLimit(usedPercentage: number): UsageQuotaLimit {
  return {
    type: "TOKENS_LIMIT",
    unit: 3,
    number: 5,
    percentage: usedPercentage,
    usageDetails: [],
  } as UsageQuotaLimit;
}

function buildDialog(controller: CodingPlanQuotaResetUiController) {
  return buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: true,
    resetUi: controller,
    usageItems: [],
    weekEnabled: true,
  });
}

function createRemainingState(limits: UsageQuotaLimit[]): CodingPlanUsageRemainingState {
  return {
    displayedEntitlement: null,
    hasAnyActiveCodingPlan: true,
    loading: false,
    providerEntitlements: [],
    tabProviders: [],
    visibleSnapshot: { quota: { limits } } as UsageEntitlementSnapshot,
  };
}

describe("Coding Plan 重置机会的满额可见性", () => {
  it("重置后余量 100% 且同类型仍有多张机会时，弹框保留该重置行与剩余张数", () => {
    // 回归：核销一张会把剩余额度乐观改写成 100%（percentage=0），随后 status 轮询发现
    // 仍有有效机会，entry 回到 available。旧口径按「剩余 100% 则重置无收益」隐藏整行，
    // 用户刚用掉一张就看不到余下的卡，以为机会被吞掉。
    const dialog = buildDialog(
      createController({
        fiveHour: {
          entry: createEntry({ opportunityCount: 2 }),
          opportunityVisible: true,
        },
      }),
    );

    const fiveHourItem = dialog.resetItems.find((item) => item.resetType === "FIVE_HOUR");
    expect(fiveHourItem).toBeDefined();
    expect(fiveHourItem?.count).toBe(2);
    expect(fiveHourItem?.expiresAt).toBe(EXPIRES_AT);
  });

  it("余量 100% 且只剩最后一张机会时同样保留重置行", () => {
    // 「有 2 张、用掉 1 张」后剩余正好 1 张，这一档也不能隐藏，否则仍是同一类投诉。
    const dialog = buildDialog(
      createController({
        fiveHour: {
          entry: createEntry({ opportunityCount: 1 }),
          opportunityVisible: true,
        },
      }),
    );

    expect(dialog.resetItems.map((item) => item.resetType)).toEqual(["FIVE_HOUR"]);
    expect(dialog.resetItems[0]?.count).toBe(1);
  });

  it("五小时与周额度同时持有机会时两行都展示，不因满额互相遮蔽", () => {
    const dialog = buildDialog(
      createController({
        fiveHour: { entry: createEntry({ opportunityCount: 3 }), opportunityVisible: true },
        week: { entry: createEntry({ opportunityCount: 2 }), opportunityVisible: true },
      }),
    );

    expect(dialog.resetItems.map((item) => [item.resetType, item.count])).toEqual([
      ["FIVE_HOUR", 3],
      ["WEEK", 2],
    ]);
  });

  it("没有可用机会时仍然隐藏重置行", () => {
    const dialog = buildDialog(
      createController({
        fiveHour: { entry: createEntry({ opportunityCount: 0 }), opportunityVisible: false },
      }),
    );

    expect(dialog.resetItems).toEqual([]);
  });

  it("processing 与 completed 期间保留重置行，完成反馈不被打断", () => {
    const processing = buildDialog(
      createController({
        fiveHour: {
          entry: createEntry({ status: "processing", startedAt: EXPIRES_AT }),
          opportunityVisible: false,
          processing: true,
        },
      }),
    );
    expect(processing.resetItems.map((item) => item.resetType)).toEqual(["FIVE_HOUR"]);
    expect(processing.resetItems[0]?.processing).toBe(true);

    const completed = buildDialog(
      createController({
        fiveHour: {
          entry: createEntry({
            status: "completed",
            opportunityCount: 0,
            opportunityExpiresAt: null,
            completedAt: EXPIRES_AT,
            quotaOverridePending: true,
          }),
          opportunityVisible: false,
          done: true,
        },
      }),
    );
    expect(completed.resetItems.map((item) => item.resetType)).toEqual(["FIVE_HOUR"]);
  });

  it("聊天输入框机会徽标在余量 100% 时仍按剩余张数展示", () => {
    // 徽标与弹框行共用同一口径：重置把 percentage 归零后，余下机会的徽标不得消失。
    const badge = resolveChatCodingPlanResetOpportunityBadge(
      createRemainingState([createLimit(0)]),
      {
        entry: createEntry({ opportunityCount: 2 }),
        opportunityVisible: true,
        week: createTypeController(),
      },
    );

    expect(badge).toEqual({ count: 2, expiresAt: EXPIRES_AT, visible: true });
  });

  it("没有对应额度条或没有可用机会时徽标保持隐藏", () => {
    expect(
      resolveChatCodingPlanResetOpportunityBadge(createRemainingState([]), {
        entry: createEntry({ opportunityCount: 2 }),
        opportunityVisible: true,
        week: createTypeController(),
      }),
    ).toEqual({ count: 0, expiresAt: null, visible: false });

    expect(
      resolveChatCodingPlanResetOpportunityBadge(createRemainingState([createLimit(0)]), {
        entry: createEntry({ opportunityCount: 0 }),
        opportunityVisible: false,
        week: createTypeController(),
      }),
    ).toEqual({ count: 0, expiresAt: null, visible: false });
  });
});
