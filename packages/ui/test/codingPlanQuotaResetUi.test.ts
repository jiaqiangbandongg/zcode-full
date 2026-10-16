import { describe, expect, it } from "vitest";
import type { CodingPlanResetStatusSnapshot, UsageQuotaLimit } from "@zcode/shared";
import {
  CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
  CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
  advanceCodingPlanQuotaResetCelebration,
  applyCodingPlanQuotaResetStatus,
  completeCodingPlanQuotaResetEntitlementRefresh,
  failCodingPlanQuotaResetManualUse,
  hasUsableCodingPlanQuotaResetOpportunity,
  startCodingPlanQuotaResetManualUse,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetAutomaticPhase,
  resolveCodingPlanQuotaResetLimit,
  resolveCodingPlanQuotaResetRemainingPercentage,
  resolveCodingPlanQuotaResetStatusVisible,
  mergeCodingPlanQuotaResetOpportunityBadges,
} from "@/lib/codingPlanQuotaResetUi.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function buildLimit(overrides: Partial<UsageQuotaLimit> = {}): UsageQuotaLimit {
  return {
    type: "TOKENS_LIMIT",
    percentage: 42,
    nextResetTime: Date.UTC(2026, 7, 7, 15, 0, 0),
    usageDetails: [],
    ...overrides,
  };
}

describe("coding plan quota reset ui state", () => {
  it("触发器撒花只认自动完成的新 used_at，手动完成不播放", () => {
    // 手动核销（非自动完成窗口）：无论是否经历 processing，触发器都不撒花。
    const manualDone = advanceCodingPlanQuotaResetCelebration(null, {
      sourceKey: "builtin:personal",
      completedAt: 1_000,
      automaticCompletion: false,
    });
    expect(manualDone.shouldCelebrate).toBe(false);

    // 自动完成：同一 source 的新 used_at 播放一次，重复渲染/轮询不重播。
    const automaticDone = advanceCodingPlanQuotaResetCelebration(manualDone.state, {
      sourceKey: "builtin:personal",
      completedAt: 2_000,
      automaticCompletion: true,
    });
    expect(automaticDone.shouldCelebrate).toBe(true);
    expect(
      advanceCodingPlanQuotaResetCelebration(automaticDone.state, {
        sourceKey: "builtin:personal",
        completedAt: 2_000,
        automaticCompletion: true,
      }).shouldCelebrate,
    ).toBe(false);

    // 同一 source 之后又发生新的自动重置（新 used_at），仍应再播放一次。
    const nextAutomatic = advanceCodingPlanQuotaResetCelebration(automaticDone.state, {
      sourceKey: "builtin:personal",
      completedAt: 3_000,
      automaticCompletion: true,
    });
    expect(nextAutomatic.shouldCelebrate).toBe(true);

    // source 切换清空轨迹：新 source 的同一 used_at 独立判断，不继承旧 source 的记录。
    const switched = advanceCodingPlanQuotaResetCelebration(nextAutomatic.state, {
      sourceKey: "team-plan:builtin:team-a",
      completedAt: 3_000,
      automaticCompletion: true,
    });
    expect(switched.shouldCelebrate).toBe(true);
    expect(switched.state).toEqual({
      sourceKey: "team-plan:builtin:team-a",
      celebratedCompletedAt: 3_000,
    });

    // 没有 completedAt 时（available/processing）永不撒花。
    expect(
      advanceCodingPlanQuotaResetCelebration(switched.state, {
        sourceKey: "team-plan:builtin:team-a",
        completedAt: null,
        automaticCompletion: true,
      }).shouldCelebrate,
    ).toBe(false);
  });

  it("只根据服务端有效机会创建 AVAILABLE，取最早过期时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const status: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [
        { expireAt: now + 60_000 },
        { expireAt: now + 30_000 },
        { expireAt: now - 1 },
      ],
      availableWeekResets: [],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };

    expect(applyCodingPlanQuotaResetStatus(null, status, now)).toEqual({
      status: "available",
      opportunityCount: 2,
      opportunityExpiresAt: now + 30_000,
      startedAt: null,
      completedAt: null,
      observedAt: null,
      quotaOverridePending: false,
      nextResetAt: null,
      idempotencyKey: null,
      error: null,
    });
  });

  it("旧历史未标记 unread 时不在首次挂载伪造完成态", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    expect(
      applyCodingPlanQuotaResetStatus(
        null,
        {
          availableFiveHourResets: [],
          availableWeekResets: [],
          latestFiveHourResetHistory: { usedAt: now - FIVE_HOURS_MS },
          latestWeekResetHistory: null,
          hasUnreadHistory: false,
        },
        now,
      ),
    ).toBeNull();
  });

  it("自动 unread 历史或手动 processing 对账后使用服务端 usedAt 完成", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const status: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };

    const automatic = applyCodingPlanQuotaResetStatus(null, status, now);
    expect(automatic?.status).toBe("completed");
    expect(automatic?.completedAt).toBe(usedAt);
    expect(automatic?.observedAt).toBe(now);
    expect(automatic?.quotaOverridePending).toBe(true);

    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...status,
        latestFiveHourResetHistory: null,
        hasUnreadHistory: false,
        availableFiveHourResets: [{ expireAt: now + 30_000 }],
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "retry-same-key", now);
    // 手动对账的 manualStartedAt 由 hook 共享轨迹给出：used_at 已不同于点击前基线。
    const manual = applyCodingPlanQuotaResetStatus(
      processing,
      { ...status, hasUnreadHistory: false },
      now + 1_000,
      now,
    );
    expect(manual?.status).toBe("completed");
    expect(manual?.completedAt).toBe(usedAt);
    expect(manual?.idempotencyKey).toBeNull();
  });

  it("跨入口观察手动完成历史时使用共享 startedAt，重复轮询不退化为自动完成", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now + 1_000;
    const manualStartedAt = now - 500;
    const snapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      // 其他入口读取前，发起入口可能已经把 unread 历史标记为已读。
      hasUnreadHistory: false,
    };

    const completed = applyCodingPlanQuotaResetStatus(null, snapshot, now, manualStartedAt);
    expect(completed?.startedAt).toBe(manualStartedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(false);

    const repeated = applyCodingPlanQuotaResetStatus(completed, snapshot, now + 30_000);
    expect(repeated?.startedAt).toBe(manualStartedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(repeated, now + 30_000)).toBe(false);
  });

  it("自动重置短提示从首次观察时间开始，重复轮询同一 usedAt 不续期", () => {
    const usedAt = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstObservedAt = usedAt + 30_000;
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };

    const first = applyCodingPlanQuotaResetStatus(null, snapshot, firstObservedAt);
    expect(first?.completedAt).toBe(usedAt);
    expect(first?.observedAt).toBe(firstObservedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(first, firstObservedAt)).toBe(true);

    const repeated = applyCodingPlanQuotaResetStatus(
      first,
      { ...snapshot, hasUnreadHistory: false },
      firstObservedAt + 2_000,
    );
    expect(repeated?.observedAt).toBe(firstObservedAt);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        repeated,
        firstObservedAt + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
      ),
    ).toBe(false);
  });

  it("手动失败恢复 AVAILABLE 并保留原幂等键供重试", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 30_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "same-key", now);
    const failed = failCodingPlanQuotaResetManualUse(processing, "code=2007");

    expect(failed).toMatchObject({
      status: "available",
      idempotencyKey: "same-key",
      error: "code=2007",
    });
    expect(
      startCodingPlanQuotaResetManualUse(failed, "must-not-replace", now + 1_000)?.idempotencyKey,
    ).toBe("same-key");
  });

  it("已完成时对 5 小时额度覆盖为 100% 剩余并改写下次重置时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: true,
      },
      now,
    );

    const overridden = resolveCodingPlanQuotaResetLimit(buildLimit(), completed);
    expect(overridden?.percentage).toBe(0);
    expect(overridden?.nextResetTime).toBe(now + FIVE_HOURS_MS);

    const refreshed = completeCodingPlanQuotaResetEntitlementRefresh(completed, now);
    expect(refreshed?.quotaOverridePending).toBe(false);
    expect(resolveCodingPlanQuotaResetLimit(buildLimit(), refreshed)).toEqual(buildLimit());
    // Bugfix：重置后额度池无活跃窗口时，刷新回来的真实额度缺失 nextResetTime；
    // 完成态期间继续用 completedAt + 周期 兜底，重置时间不能闪现即消失。
    expect(
      resolveCodingPlanQuotaResetLimit(buildLimit({ nextResetTime: undefined }), refreshed),
    ).toMatchObject({ percentage: 42, nextResetTime: now + FIVE_HOURS_MS });
    const repeated = applyCodingPlanQuotaResetStatus(
      refreshed,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now + 30_000,
    );
    expect(repeated?.quotaOverridePending).toBe(false);

    // 未完成（available / processing）时保留服务端真实额度。
    expect(
      resolveCodingPlanQuotaResetLimit(
        buildLimit(),
        applyCodingPlanQuotaResetStatus(
          null,
          {
            availableFiveHourResets: [{ expireAt: now + 60_000 }],
            availableWeekResets: [],
            latestFiveHourResetHistory: null,
            latestWeekResetHistory: null,
            hasUnreadHistory: false,
          },
          now,
        ),
      ),
    ).toEqual(buildLimit());
    expect(
      resolveCodingPlanQuotaResetLimit(
        buildLimit(),
        startCodingPlanQuotaResetManualUse(
          applyCodingPlanQuotaResetStatus(
            null,
            {
              availableFiveHourResets: [{ expireAt: now + 60_000 }],
              availableWeekResets: [],
              latestFiveHourResetHistory: null,
              latestWeekResetHistory: null,
              hasUnreadHistory: false,
            },
            now,
          ),
          "key",
          now,
        ),
      ),
    ).toEqual(buildLimit());
  });

  it("未完成时保留服务端返回的真实剩余百分比", () => {
    expect(
      resolveCodingPlanQuotaResetRemainingPercentage(
        37,
        applyCodingPlanQuotaResetStatus(
          null,
          {
            availableFiveHourResets: [{ expireAt: Date.UTC(2026, 7, 7) + 60_000 }],
            availableWeekResets: [],
            latestFiveHourResetHistory: null,
            latestWeekResetHistory: null,
            hasUnreadHistory: false,
          },
          Date.UTC(2026, 7, 7),
        ),
      ),
    ).toBe(37);
  });

  it("手动重置只播放按钮烟花，不显示 processing 或 completed Tooltip", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 60_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(resolveCodingPlanQuotaResetStatusVisible(available, now)).toBe(false);

    const processing = startCodingPlanQuotaResetManualUse(available, "key", now);
    expect(resolveCodingPlanQuotaResetStatusVisible(processing, now + 999_999)).toBe(false);

    const completed = applyCodingPlanQuotaResetStatus(
      processing,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(false);
  });

  it("自动或运营重置的 completed Tooltip 在展示窗口结束后收起", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now - 30_000 },
        latestWeekResetHistory: null,
        hasUnreadHistory: true,
      },
      now,
    );

    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(true);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        completed,
        now + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS - 1,
      ),
    ).toBe(true);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        completed,
        now + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
      ),
    ).toBe(false);
    expect(resolveCodingPlanQuotaResetStatusVisible(null, now)).toBe(false);
  });

  it("Composer 自动重置合成阶段：先正在重置再常驻已重置，hover 收起且手动/未完成不进入", () => {
    const usedAt = Date.UTC(2026, 7, 7, 10, 0, 0);
    const observedAt = usedAt + 30_000;
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const automatic = applyCodingPlanQuotaResetStatus(null, snapshot, observedAt);
    expect(automatic?.startedAt).toBeNull();
    expect(automatic?.observedAt).toBe(observedAt);

    // 首次观察起约 1 秒展示“正在重置”。
    expect(resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt, false)).toBe(
      "processing",
    );
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(
        automatic,
        observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS - 1,
        false,
      ),
    ).toBe("processing");

    // 到期后切换为“已重置”，且无上限、一直保留。
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(
        automatic,
        observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
        false,
      ),
    ).toBe("completed");
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt + 3_600_000, false),
    ).toBe("completed");

    // hover 收起后返回 null。
    expect(resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt, true)).toBeNull();

    // 手动完成（startedAt 不为空）不进入触发器合成阶段。
    const manual = applyCodingPlanQuotaResetStatus(null, snapshot, observedAt, usedAt - 500);
    expect(manual?.startedAt).toBe(usedAt - 500);
    expect(resolveCodingPlanQuotaResetAutomaticPhase(manual, observedAt, false)).toBeNull();

    // available / null 不进入。
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: observedAt + 60_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      observedAt,
    );
    expect(resolveCodingPlanQuotaResetAutomaticPhase(available, observedAt, false)).toBeNull();
    expect(resolveCodingPlanQuotaResetAutomaticPhase(null, observedAt, false)).toBeNull();
  });

  it("按 resetType 读取周额度机会创建 AVAILABLE", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const status: CodingPlanResetStatusSnapshot = {
      // 五小时无机会，周额度有机会：resetType=WEEK 只应读取周字段。
      availableFiveHourResets: [],
      availableWeekResets: [{ expireAt: now + 90_000 }, { expireAt: now + 45_000 }],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };

    expect(applyCodingPlanQuotaResetStatus(null, status, now, null, "WEEK")).toMatchObject({
      status: "available",
      opportunityCount: 2,
      opportunityExpiresAt: now + 45_000,
    });
    // 同一 status 下 FIVE_HOUR 无机会，不应被周机会带出 available。
    expect(applyCodingPlanQuotaResetStatus(null, status, now)).toBeNull();
  });

  it("周额度未读历史完成时按 7 天乐观改写下次重置时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: { usedAt },
        hasUnreadHistory: true,
      },
      now,
      null,
      "WEEK",
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBe(usedAt);
    expect(completed?.nextResetAt).toBe(usedAt + WEEK_MS);

    const overridden = resolveCodingPlanQuotaResetLimit(buildLimit(), completed);
    expect(overridden?.percentage).toBe(0);
    expect(overridden?.nextResetTime).toBe(usedAt + WEEK_MS);
  });

  it("同一 used_at 周期内新发放的机会打破粘滞完成态,回到 AVAILABLE", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const completedSnapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(null, completedSnapshot, now);
    expect(completed?.status).toBe("completed");

    // 后端在同一周期内(used_at 未变)再次发放机会:完成态必须让位,否则新机会被
    // UI 永久吞掉,用户要重新登录清空窗口内存态才能看到重置入口。
    const regrantSnapshot: CodingPlanResetStatusSnapshot = {
      ...completedSnapshot,
      availableFiveHourResets: [{ expireAt: now + 120_000 }],
      hasUnreadHistory: false,
    };
    const revived = applyCodingPlanQuotaResetStatus(completed, regrantSnapshot, now + 60_000);
    expect(revived?.status).toBe("available");
    expect(revived?.opportunityCount).toBe(1);

    // 共享手动轨迹归因同理:有新机会时不再把 used_at 归为旧的手动完成。
    expect(
      applyCodingPlanQuotaResetStatus(null, regrantSnapshot, now + 60_000, usedAt - 500)?.status,
    ).toBe("available");

    // 没有新机会时粘滞保持:重复轮询不得把完成态清空。
    const sticky = applyCodingPlanQuotaResetStatus(
      completed,
      { ...completedSnapshot, hasUnreadHistory: false },
      now + 60_000,
    );
    expect(sticky?.status).toBe("completed");

    // 刚发现的未读完成优先于新机会:完成提示与额度校正先播,下一轮再让位。
    const unreadWithOpportunity = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...regrantSnapshot,
        hasUnreadHistory: true,
      },
      now,
    );
    expect(unreadWithOpportunity?.status).toBe("completed");

    // processing 对账不受影响:机会余额 >0 时手动 /use 确认循环仍能看到 completed。
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...completedSnapshot,
        latestFiveHourResetHistory: null,
        hasUnreadHistory: false,
        availableFiveHourResets: [{ expireAt: now + 60_000 }],
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "key", now);
    const confirmed = applyCodingPlanQuotaResetStatus(
      processing,
      regrantSnapshot,
      now + 1_000,
      now,
    );
    expect(confirmed?.status).toBe("completed");
  });

  it("同类型多张机会：完成态携带余下机会，可直接再次核销，耗尽后不可核销", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstUsedAt = now + 1_000;
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 60_000 }, { expireAt: now + 120_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(hasUsableCodingPlanQuotaResetOpportunity(available, now)).toBe(true);
    const processing = startCodingPlanQuotaResetManualUse(available, "first-key", now);
    // processing 期间不可再次核销，避免同一张机会重复发 /use。
    expect(hasUsableCodingPlanQuotaResetOpportunity(processing, now)).toBe(false);

    // 核销最早到期的一张：同一 status 快照同时给出 used_at 与余下 1 张机会。
    const afterFirstUse: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [{ expireAt: now + 120_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: firstUsedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(processing, afterFirstUse, now + 2_000, now);
    expect(completed).toMatchObject({
      status: "completed",
      completedAt: firstUsedAt,
      // 完成态不再把余下机会清零，否则弹框会把空到期渲染成「0 分 0 秒」。
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: null,
    });
    expect(hasUsableCodingPlanQuotaResetOpportunity(completed, now + 2_000)).toBe(true);

    // 完成态下直接再次核销：进入 processing 并生成新的幂等键，保留机会快照供失败恢复。
    const secondProcessing = startCodingPlanQuotaResetManualUse(
      completed,
      "second-key",
      now + 3_000,
    );
    expect(secondProcessing).toMatchObject({
      status: "processing",
      startedAt: now + 3_000,
      completedAt: null,
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: "second-key",
    });
    expect(failCodingPlanQuotaResetManualUse(secondProcessing, "code=2007")).toMatchObject({
      status: "available",
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: "second-key",
    });

    // 最后一张核销后机会耗尽：完成态张数为 0、到期为空，不可再核销。
    const exhausted = applyCodingPlanQuotaResetStatus(
      secondProcessing,
      {
        ...afterFirstUse,
        availableFiveHourResets: [],
        latestFiveHourResetHistory: { usedAt: now + 4_000 },
      },
      now + 5_000,
      now + 3_000,
    );
    expect(exhausted).toMatchObject({
      status: "completed",
      completedAt: now + 4_000,
      opportunityCount: 0,
      opportunityExpiresAt: null,
    });
    expect(hasUsableCodingPlanQuotaResetOpportunity(exhausted, now + 5_000)).toBe(false);
    expect(startCodingPlanQuotaResetManualUse(exhausted, "noop-key", now + 5_000)).toBe(exhausted);

    // 余下机会已过期：同样不可核销，start 保持原状态。
    expect(hasUsableCodingPlanQuotaResetOpportunity(completed, now + 120_000)).toBe(false);
    expect(startCodingPlanQuotaResetManualUse(completed, "expired-key", now + 120_000)).toBe(
      completed,
    );
    expect(hasUsableCodingPlanQuotaResetOpportunity(null, now)).toBe(false);

    // 额度标题旁操作：仍有可核销机会时不展示「已重置」锚点，保持「重置」入口；耗尽后才展示。
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: completed, opportunityVisible: true }),
    ).toBeNull();
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: exhausted, opportunityVisible: false }),
    ).toBe(now + 4_000);
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: null, opportunityVisible: false }),
    ).toBeNull();
  });

  it("processing 只认不同于点击前基线的新 used_at：滞后快照（含 unread 未清）保持处理中", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstUsedAt = now - 2_000;
    // 第一张刚核销：完成态携带余下 1 张，上一张的 history/read 可能尚未生效。
    const afterFirstUse: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [{ expireAt: now + 60_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: firstUsedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      afterFirstUse,
      now - 1_000,
      now - 3_000,
    );
    expect(completed).toMatchObject({ status: "completed", opportunityCount: 1 });

    const processing = startCodingPlanQuotaResetManualUse(completed, "second-key", now);
    // /use 后 status 仍是消费前快照：共享轨迹比较基线后不给 manualStartedAt。
    // 无论 unread 是否已清，都不能把上一张的 used_at 当成本次完成。
    for (const hasUnreadHistory of [true, false]) {
      expect(
        applyCodingPlanQuotaResetStatus(
          processing,
          { ...afterFirstUse, hasUnreadHistory },
          now + 100,
        ),
      ).toBe(processing);
    }

    // 读到新的 used_at 后轨迹绑定、给出 manualStartedAt，才进入完成并按新快照展示余下张数。
    const confirmed = applyCodingPlanQuotaResetStatus(
      processing,
      {
        ...afterFirstUse,
        availableFiveHourResets: [],
        latestFiveHourResetHistory: { usedAt: now + 500 },
      },
      now + 800,
      now,
    );
    expect(confirmed).toMatchObject({
      status: "completed",
      completedAt: now + 500,
      startedAt: now,
      opportunityCount: 0,
    });
  });

  it("五小时与周机会徽标合并:次数累加,倒计时取最早到期,单侧可见时只计该侧", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    // 双侧可见:次数累加,倒计时取更早的周机会到期时间。
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 2, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: now + 30_000, visible: true },
      ]),
    ).toEqual({ count: 3, expiresAt: now + 30_000, visible: true });

    // 一侧隐藏(额度满/无机会):只显示可见一侧,不把隐藏侧的次数累进去。
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 2, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: now + 30_000, visible: false },
      ]),
    ).toEqual({ count: 2, expiresAt: now + 60_000, visible: true });

    // 全部隐藏或次数为 0:徽标不可见。
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 0, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: null, visible: false },
      ]),
    ).toEqual({ count: 0, expiresAt: null, visible: false });
  });

  it("共享 has_unread_history 只归属 used_at 最新的一类，避免错误完成另一类", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const staleFiveHourUsedAt = now - FIVE_HOURS_MS;
    const freshWeekUsedAt = now - 1_000;
    // 单一 unread 游标 + 两类历史：只有 used_at 最新的周额度应进入完成态。
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: staleFiveHourUsedAt },
      latestWeekResetHistory: { usedAt: freshWeekUsedAt },
      hasUnreadHistory: true,
    };

    // 过期的五小时历史不拥有 unread 标记，首次挂载不得伪造完成。
    expect(applyCodingPlanQuotaResetStatus(null, snapshot, now, null, "FIVE_HOUR")).toBeNull();

    // 更新的周历史拥有 unread 标记，正常完成。
    const week = applyCodingPlanQuotaResetStatus(null, snapshot, now, null, "WEEK");
    expect(week?.status).toBe("completed");
    expect(week?.completedAt).toBe(freshWeekUsedAt);

    // used_at 相等时按当前类型归属：两类都能各自完成，不会互相抢占。
    const tie: CodingPlanResetStatusSnapshot = {
      ...snapshot,
      latestFiveHourResetHistory: { usedAt: freshWeekUsedAt },
    };
    expect(applyCodingPlanQuotaResetStatus(null, tie, now, null, "FIVE_HOUR")?.status).toBe(
      "completed",
    );
    expect(applyCodingPlanQuotaResetStatus(null, tie, now, null, "WEEK")?.status).toBe("completed");
  });
});
