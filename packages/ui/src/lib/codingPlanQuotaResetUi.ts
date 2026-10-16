import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";

// 进度条从当前占用恢复到 100% 的动画时长，沿用现有 500ms ease-out。
export const CODING_PLAN_QUOTA_RESET_PROGRESS_DURATION_MS = 500;
// 完成后“额度已重置”提示的停留时长，随后自动收起提示（额度条保持 100%）。
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// 自动/运营重置在 Composer 触发器上先合成一小段“正在重置”的时长，随后切换为“已重置”。
// 后端没有 processing 信号，这里仅在客户端还原一次“处理中→已重置”的观感。
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// 完成后乐观改写“下一次重置时间”的周期：五小时额度按 5 小时，周额度按 7 天。
export function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available：服务端下发了可用的五小时重置机会。
// processing：用户已发起手动核销，正在等待 use + status 对账。
// completed：status 已返回服务端 used_at；自动/运营重置不会经过 processing。
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** 剩余重置机会次数；completed 携带同一 status 快照余下的有效机会，processing 保留点击前快照。 */
  opportunityCount: number;
  /** 最早的重置机会到期时刻；无余下机会时为 null。 */
  opportunityExpiresAt: number | null;
  /** 本地手动核销开始时刻；自动/运营重置为 null。 */
  startedAt: number | null;
  /** 服务端 latest_{five_hour,week}_reset_history.used_at。 */
  completedAt: number | null;
  /** 客户端首次观察到当前 completedAt 的时间，仅用于短提示和动效。 */
  observedAt: number | null;
  /** entitlement 刷新成功前允许临时把额度覆盖为 100%。 */
  quotaOverridePending: boolean;
  nextResetAt: number | null;
  /** 同一次失败重试必须复用的幂等键；成功对账后清空。 */
  idempotencyKey: string | null;
  error: string | null;
}

export interface CodingPlanQuotaResetCelebrationState {
  sourceKey: string | null;
  /** 已从触发器为该 used_at 撒过花；同一次完成在重复渲染/轮询时不得重播。 */
  celebratedCompletedAt: number | null;
}

/** 同一 source 下五小时与周额度各自独立的重置状态。 */
export interface CodingPlanQuotaResetUiEntries {
  fiveHour: CodingPlanQuotaResetUiEntry | null;
  week: CodingPlanQuotaResetUiEntry | null;
}

/** 五小时/周共用同一份重置状态机，只在读取机会/历史字段时按类型区分。 */
export const CODING_PLAN_QUOTA_RESET_TYPES = [
  "FIVE_HOUR",
  "WEEK",
] as const satisfies readonly CodingPlanResetType[];

export function advanceCodingPlanQuotaResetCelebration(
  previous: CodingPlanQuotaResetCelebrationState | null,
  input: {
    sourceKey: string | null;
    completedAt: number | null;
    /** 自动/运营完成（startedAt 为空）的短提示窗口；手动重置由按钮自身撒花，触发器不参与。 */
    automaticCompletion: boolean;
  },
): {
  state: CodingPlanQuotaResetCelebrationState;
  shouldCelebrate: boolean;
} {
  // 手动核销同样会经过 processing，“见过 processing”不能再作为触发器撒花依据，
  // 否则手动重置会叠加按钮和触发器两处动画。触发器只认自动完成的新 used_at，
  // source 切换时清空轨迹，避免 Team/个人套餐之间重复撒花或漏掉自动重置动效。
  const sourceChanged = previous?.sourceKey !== input.sourceKey;
  const celebratedCompletedAt = sourceChanged ? null : (previous?.celebratedCompletedAt ?? null);
  const shouldCelebrate = Boolean(
    input.sourceKey &&
    input.automaticCompletion &&
    input.completedAt !== null &&
    input.completedAt !== celebratedCompletedAt,
  );

  return {
    state: {
      sourceKey: input.sourceKey,
      celebratedCompletedAt: shouldCelebrate ? input.completedAt : celebratedCompletedAt,
    },
    shouldCelebrate,
  };
}

function createAvailableEntry(
  opportunityCount: number,
  opportunityExpiresAt: number,
  idempotencyKey: string | null,
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount,
    opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey,
    error: null,
  };
}

function createCompletedEntry(
  previous: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
  observedAt: number,
  manualStartedAt: number | null,
  nextResetMs: number,
  remainingOpportunities: ReadonlyArray<{ expireAt: number }>,
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    // Bugfix：完成态曾把机会张数/到期清零。同类型持有多张机会时，核销一张后余下的卡要等
    // 下一次 status 让位回 available 才恢复：期间弹框行把空到期渲染成「0 分 0 秒后过期」，
    // 再次点击被 reset() 静默忽略，只能重开弹框触发立即校正。完成与机会余额是同一份
    // status 快照的两个正交维度，这里如实保留余下的有效机会（调用方已按到期升序），
    // 是否可再次核销统一由 hasUsableCodingPlanQuotaResetOpportunity 判定。
    opportunityCount: remainingOpportunities.length,
    opportunityExpiresAt: remainingOpportunities[0]?.expireAt ?? null,
    // Bugfix：手动点击和完成历史可能由不同入口观察。只依赖当前 source 的 processing
    // 会让 Composer 把设置页发起的手动重置误判成自动重置，重复显示 Tooltip 和烟花。
    // 同一完成历史重复对账时也必须保留原分类，不能在下一次轮询时退化为自动完成。
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // 自动/运营重置可能在 used_at 之后最多 60 秒才被轮询发现。
    // 短提示必须从首次观察时刻起算；同一 used_at 的重复轮询则不能续期。
    observedAt: isSameCompletion ? (previous.observedAt ?? observedAt) : observedAt,
    quotaOverridePending: isSameCompletion ? previous.quotaOverridePending : true,
    nextResetAt: completedAt + nextResetMs,
    idempotencyKey: null,
    error: null,
  };
}

/**
 * 把服务端 status 应用到窗口内共享 UI 状态。
 *
 * 旧历史且 has_unread_history=false 不能在首次挂载时进入 completed，
 * 否则客户端会把几小时前的历史重置错误覆盖成当前 100% 剩余额度。
 *
 * resetType 决定读取五小时还是周额度的机会/历史。has_unread_history 是两种重置
 * 类型共享的单一游标，因此只有 used_at 最新的那一类“拥有”这个未读标记：否则一次
 * 周重置就会把过期的五小时历史误判为刚完成，反之亦然。
 */
export function applyCodingPlanQuotaResetStatus(
  previous: CodingPlanQuotaResetUiEntry | null,
  status: CodingPlanResetStatusSnapshot,
  now: number,
  manualStartedAt: number | null = null,
  resetType: CodingPlanResetType = "FIVE_HOUR",
): CodingPlanQuotaResetUiEntry | null {
  const availableResets =
    resetType === "WEEK" ? status.availableWeekResets : status.availableFiveHourResets;
  const latestUsedAt =
    (resetType === "WEEK"
      ? status.latestWeekResetHistory?.usedAt
      : status.latestFiveHourResetHistory?.usedAt) ?? null;
  const otherUsedAt =
    (resetType === "WEEK"
      ? status.latestFiveHourResetHistory?.usedAt
      : status.latestWeekResetHistory?.usedAt) ?? null;
  // 共享 has_unread_history 只归属 used_at 最新的一类；相等时按当前类型归属，
  // 保证有新历史时至少有一类能进入完成态，且不会两类同时抢占。
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // 同一 used_at 的粘滞完成态与共享手动轨迹归因只在“没有新机会”时生效。
  // 后端可能在同一重置周期内（used_at 未变）再次发放机会；若完成态继续优先，新机会
  // 会被 UI 永久吞掉，用户重新登录（清空窗口内存态）才能看到入口。有效机会到来即视为
  // 进入新一轮周期，回到 AVAILABLE。ownsUnread（刚发现的未读完成）不受影响：完成提示
  // 与额度校正先播，history/read 后的下一轮再让位；processing 对账也不受影响：机会
  // 余额 >0 时手动 /use 确认循环仍必须看到 completed。
  const hasValidOpportunity = validOpportunities.length > 0;
  // Bugfix：processing 曾以「used_at 非空」即确认成功。从 COMPLETED（余下 N 张）再次核销时，
  // 点击前基线就是上一张的 used_at；/use 后 status 读数滞后（仍是上一张 used_at，unread 也可能
  // 未清）会被当成第二次成功：弹框提前播放成功反馈、余量仍显示旧值，且共享轨迹停在
  // completedAt=null，下一次点击被跨入口防双核销静默拦下。processing 只认手动轨迹给出的
  // manualStartedAt（hook 仅在 used_at 不同于点击前基线时返回），读到基线则继续等待，
  // 4 次对账都未见新 used_at 由 hook 走失败恢复。
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (previous?.status === "processing"
      ? manualStartedAt !== null
      : ownsUnread ||
        ((manualStartedAt !== null ||
          (previous?.status === "completed" && previous.completedAt === latestUsedAt)) &&
          !hasValidOpportunity)),
  );
  if (shouldComplete && latestUsedAt !== null) {
    return createCompletedEntry(
      previous,
      latestUsedAt,
      now,
      manualStartedAt,
      resolveCodingPlanQuotaResetDurationMs(resetType),
      validOpportunities,
    );
  }

  // 手动 use 期间 status 轮询可能仍读到消费前快照（used_at 为空或仍是点击前基线）。此时保持
  // processing，只有不同于基线的新 used_at 才能确认成功，不能被旧 opportunity 回退成可再次点击。
  if (previous?.status === "processing") {
    return previous;
  }

  const earliest = validOpportunities[0];
  if (earliest) {
    return createAvailableEntry(
      validOpportunities.length,
      earliest.expireAt,
      previous?.status === "available" ? previous.idempotencyKey : null,
    );
  }

  return null;
}

/**
 * 「是否仍可核销」的唯一判定：非 processing、张数 > 0 且最早机会晚于 now 到期。
 * available 与携带余下机会的 completed 同样适用；徽标、标题旁「重置」、弹框行与
 * reset() 放行都以此为准，不再各自按 status === "available" 判断。
 */
export function hasUsableCodingPlanQuotaResetOpportunity(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
): boolean {
  return Boolean(
    entry &&
    entry.status !== "processing" &&
    entry.opportunityCount > 0 &&
    entry.opportunityExpiresAt !== null &&
    entry.opportunityExpiresAt > now,
  );
}

/**
 * 额度标题旁操作的完成时刻：仍有可核销机会时返回 null（展示可点击「重置」打开弹框），
 * 否则返回 completedAt（completed 展示「已重置」）。
 * Bugfix：completed 携带余下机会后，若仍直接传 entry.completedAt，同类型还有卡时标题
 * 也会显示「已重置」，用户无法从标题再次打开弹框核销余下的卡。
 */
export function resolveCodingPlanQuotaResetActionCompletedAt(controller: {
  entry: CodingPlanQuotaResetUiEntry | null;
  opportunityVisible: boolean;
}): number | null {
  return controller.opportunityVisible ? null : (controller.entry?.completedAt ?? null);
}

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  // completed 携带的余下机会同样可直接核销（completed → processing）；其 idempotencyKey
  // 已在完成时清空，下方会换用本次的新 key，不会复用上一张的 key。
  if (!entry || !hasUsableCodingPlanQuotaResetOpportunity(entry, now)) {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // processing 时保留点击前的机会快照，失败后才能无损恢复并复用幂等键。
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: now,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: entry.idempotencyKey ?? idempotencyKey,
    error: null,
  };
}

export function failCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  error: string,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "processing") {
    return entry;
  }

  return {
    ...entry,
    status: "available",
    // 失败恢复必须保留点击前的机会数量和过期时间，否则入口会消失，
    // 用户也无法用原幂等键重试同一次核销。
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    error,
  };
}

export function resolveCodingPlanQuotaResetRemainingPercentage(
  remainingPercentage: number | null,
  entry: CodingPlanQuotaResetUiEntry | null,
): number | null {
  return entry?.status === "completed" && entry.quotaOverridePending ? 100 : remainingPercentage;
}

/**
 * 合并五小时与周额度的机会徽标展示：一个礼物徽标、次数累加，
 * 倒计时取可见机会中最早到期的一档；某档到期/隐藏后自动回落到剩余档。
 * 仅影响徽标展示，重置按钮仍按类型各自独立。
 */
export function mergeCodingPlanQuotaResetOpportunityBadges(
  items: ReadonlyArray<{
    count: number;
    expiresAt: number | null;
    visible: boolean;
  }>,
): { count: number; expiresAt: number | null; visible: boolean } {
  const visibleItems = items.filter((item) => item.visible && item.count > 0);
  return {
    count: visibleItems.reduce((sum, item) => sum + item.count, 0),
    expiresAt:
      visibleItems
        .map((item) => item.expiresAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0] ?? null,
    visible: visibleItems.length > 0,
  };
}

export function completeCodingPlanQuotaResetEntitlementRefresh(
  entry: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    entry?.status !== "completed" ||
    entry.completedAt !== completedAt ||
    !entry.quotaOverridePending
  ) {
    return entry;
  }
  return { ...entry, quotaOverridePending: false };
}

export function resolveCodingPlanQuotaResetLimit(
  limit: UsageQuotaLimit | null | undefined,
  entry: CodingPlanQuotaResetUiEntry | null,
): UsageQuotaLimit | null {
  if (!limit) {
    return null;
  }
  if (entry?.status !== "completed") {
    return limit;
  }
  if (!entry.quotaOverridePending) {
    // 重置后额度池没有活跃窗口（新窗口从下一条 prompt 才开始），刷新回来的真实
    // 额度可能缺失 nextResetTime。entitlement 刷新几乎与完成同 tick，乐观改写只存活几百
    // 毫秒，「重置时间」会闪现即消失。完成态期间继续用 completedAt + 周期 兜底展示；
    // 服务端一旦给出真实窗口（用户已发新消息）则立即让位。percentage 不再覆盖，以刷新为准。
    return limit.nextResetTime == null && entry.nextResetAt !== null
      ? { ...limit, nextResetTime: entry.nextResetAt }
      : limit;
  }

  return {
    ...limit,
    // quota 接口的 percentage 表示已使用占比；UI 完成态覆盖为 0% 已使用，即 100% 剩余。
    percentage: 0,
    nextResetTime: entry.nextResetAt ?? limit.nextResetTime,
  };
}

// available 由礼物徽标 +「重置」按钮承载，因此不打开工具栏 Tooltip。
// 手动重置已经由按钮自身展示 loading，并在成功后播放烟花；如果这里再展示
// processing/completed Tooltip，会形成重复反馈。只有自动/运营完成（startedAt 为空）保留短提示。
export function resolveCodingPlanQuotaResetStatusVisible(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  doneDisplayMs: number = CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
): boolean {
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return false;
  }
  return now - entry.observedAt < doneDisplayMs;
}

// Composer 触发器上自动/运营重置提示的合成阶段：
// - processing：首次观察后约 1 秒展示“正在重置”，还原服务端处理中的观感（后端无 processing 信号）。
// - completed：随后切换为“已重置”，并一直保留，直到用户 hover 触发器查看额度面板后由组件收起。
// dismissed=true（已 hover 收起）或非自动完成（手动 startedAt 不为空 / 未完成 / 未观察）时返回 null。
export type CodingPlanQuotaResetAutomaticPhase = "processing" | "completed";

export function resolveCodingPlanQuotaResetAutomaticPhase(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  dismissed: boolean,
  processingMs: number = CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
): CodingPlanQuotaResetAutomaticPhase | null {
  if (dismissed) {
    return null;
  }
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return null;
  }
  return now - entry.observedAt < processingMs ? "processing" : "completed";
}

/**
 * 清除已失效的补播撒花 arm：armed 的 used_at 不再是当前生效的自动完成
 * （被跨窗口抑制置空 observedAt，或被更新的 used_at 取代）时必须清 arm，
 * 否则其他窗口 hover 面板时仍会从「已重置」位置撒花，违背“多窗口只播一次”。
 */
export function pruneCodingPlanQuotaResetConfettiArms(
  arms: Record<CodingPlanResetType, number | null>,
  automaticCompletedAtByType: Record<CodingPlanResetType, number | null>,
): Record<CodingPlanResetType, number | null> {
  let changed = false;
  const next = { ...arms };
  for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
    const armed = next[resetType];
    if (armed !== null && automaticCompletedAtByType[resetType] !== armed) {
      next[resetType] = null;
      changed = true;
    }
  }
  return changed ? next : arms;
}
