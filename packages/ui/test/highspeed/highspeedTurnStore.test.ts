import { describe, expect, it } from "vitest";
import {
  aggregateHighspeedCardMetrics,
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedTurnByCommandId,
  getHighspeedTurnVersion,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  markHighspeedTurnMetricsPersisted,
  markHighspeedCardAutoShared,
  recordHighspeedTurn,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
} from "@/highspeed/highspeedTurnStore.js";
import { claimHighspeedFallbackToast } from "@/highspeed/highspeedToastClaims.js";

const card = {
  cardId: "hsc-aggregate-test",
  taskId: "task-aggregate-test",
  provider: "zai",
  model: "glm-highspeed",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  regularTps: 75,
};

describe("highspeed turn store", () => {
  it("claims a fallback toast once across SessionPane remounts", () => {
    const sourceCommandId = "command-fallback-toast-once";

    expect(claimHighspeedFallbackToast(sourceCommandId)).toBe(true);
    // 第二个 pane 或组件重挂载不能为同一降级事件再次弹 Toast。
    expect(claimHighspeedFallbackToast(sourceCommandId)).toBe(false);
  });

  it("limits healthy sampling to one expiry attempt and one final-turn补查 per card", () => {
    const cardId = "hsc-healthy-attempt-guard";

    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(true);
    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(false);
    // SessionPane 重挂载后仍复用 store 里的卡级防重状态。
    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(false);
    expect(claimHighspeedHealthyAttempt(cardId, true)).toBe(true);
    expect(claimHighspeedHealthyAttempt(cardId, true)).toBe(false);
  });

  it("hydrates persisted transcript rows after a renderer cold start", () => {
    const sourceCommandId = "command-cold-recovery";
    const cardId = "hsc-cold-recovery";
    const expiresAt = Date.now() - 1;

    expect(
      hydrateHighspeedTurnsFromTranscript("session-cold-recovery", [
        {
          sourceCommandId,
          createdAt: 10,
          highspeed: {
            cardId,
            taskId: "task-cold-recovery",
            provider: "zai",
            model: "glm-highspeed",
            issuedAt: 1,
            expiresAt,
            regularTps: 80,
            outputTokens: 120,
            durationMs: 1_000,
            highspeedTps: 120,
            savedDurationMs: 500,
          },
        },
      ]),
    ).toBe(1);

    const record = getHighspeedTurnByCommandId(sourceCommandId);
    expect(record?.metrics).toMatchObject({
      outputTokens: 120,
      durationMs: 1_000,
      highspeedTps: 120,
      savedDurationMs: 500,
    });
    expect(record?.metricsPersistedAt).toBeDefined();
    expect(listExpiredHighspeedCardsAwaitingTps("session-cold-recovery", Date.now())).toEqual([]);
  });

  it("merges late authoritative metadata into an already registered turn", () => {
    // CR-04 回归：远控 Renderer 先按运行中的 user row 登记记录；桌面端随后完成 CLI 统计持久化并
    // 投影到 transcript。旧实现发现同 sourceCommandId 已存在就跳过，远端永远缺完成态，卡级 TPS、
    // 节省时间与自动分享候选都无法收口。水合必须按 sourceCommandId 幂等合并权威字段。
    const sessionId = "session-late-merge";
    const sourceCommandId = "command-late-merge";
    const cardId = "hsc-late-merge";
    const runningRow = {
      sourceCommandId,
      createdAt: 10,
      highspeed: {
        cardId,
        taskId: sessionId,
        provider: "zai",
        model: "glm-highspeed",
        issuedAt: 1,
        expiresAt: 50,
        regularTps: 80,
      },
    };
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [runningRow])).toBe(1);
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metrics).toBeUndefined();
    expect(listHighspeedCardAutoShareCandidates(sessionId)).toEqual([]);

    const versionBefore = getHighspeedTurnVersion();
    const completedRow = {
      ...runningRow,
      highspeed: {
        ...runningRow.highspeed,
        outputTokens: 120,
        durationMs: 1_000,
        modelDurationMs: 800,
        toolDurationMs: 100,
        otherDurationMs: 100,
        highspeedTps: 120,
        savedDurationMs: 500,
      },
    };
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [completedRow])).toBe(1);
    // 迟到的完整 metadata 只产生一次 store 通知。
    expect(getHighspeedTurnVersion()).toBe(versionBefore + 1);
    expect(getHighspeedTurnByCommandId(sourceCommandId)).toMatchObject({
      metrics: {
        outputTokens: 120,
        durationMs: 1_000,
        modelDurationMs: 800,
        toolDurationMs: 100,
        otherDurationMs: 100,
        regularTps: 80,
        highspeedTps: 120,
        savedDurationMs: 500,
      },
    });
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metricsPersistedAt).toBeDefined();
    expect(listHighspeedCardAutoShareCandidates(sessionId)).toHaveLength(1);
    expect(listHighspeedCardAutoShareCandidates(sessionId)[0]?.metrics).toMatchObject({
      outputTokens: 120,
      highspeedTps: 120,
      savedDurationMs: 500,
    });

    // 完全相同的再次水合是幂等 no-op：不改记录、不通知。
    const versionAfter = getHighspeedTurnVersion();
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [completedRow])).toBe(0);
    expect(getHighspeedTurnVersion()).toBe(versionAfter);
  });

  it("never clears a live completion when the transcript row is still running", () => {
    const sessionId = "session-keep-live-completion";
    const sourceCommandId = "command-keep-live-completion";
    const liveCard = { ...card, cardId: "hsc-keep-live-completion", taskId: sessionId };
    recordHighspeedTurn({ sessionId, sourceCommandId, card: liveCard, createdAt: 1 });
    completeHighspeedTurn({ sourceCommandId, outputTokens: 90, durationMs: 700 });

    const versionBefore = getHighspeedTurnVersion();
    // transcript 仍是运行态（无完成字段）：运行态字段不得覆盖已完成字段，也不应产生通知。
    expect(
      hydrateHighspeedTurnsFromTranscript(sessionId, [
        {
          sourceCommandId,
          createdAt: 1,
          highspeed: {
            cardId: liveCard.cardId,
            taskId: sessionId,
            provider: liveCard.provider,
            model: liveCard.model,
            issuedAt: liveCard.issuedAt,
            expiresAt: liveCard.expiresAt,
            regularTps: liveCard.regularTps,
          },
        },
      ]),
    ).toBe(0);
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metrics).toMatchObject({
      outputTokens: 90,
      durationMs: 700,
    });
    expect(getHighspeedTurnVersion()).toBe(versionBefore);
  });

  it("discards a queued Highspeed record when promotion falls back to the session model", () => {
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-queued-expired",
      card,
      createdAt: 0,
    });

    expect(discardHighspeedTurn("command-queued-expired")).toBe(true);
    expect(getHighspeedTurnByCommandId("command-queued-expired")).toBeNull();
  });

  it("aggregates output tokens and duration for all completed turns on the same card", () => {
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-aggregate-1",
      card,
      createdAt: 1,
    });
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-aggregate-2",
      card,
      createdAt: 2,
    });

    completeHighspeedTurn({
      sourceCommandId: "command-aggregate-1",
      outputTokens: 120,
      durationMs: 1_500,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-aggregate-2",
      outputTokens: 80,
      durationMs: 2_500,
    });
    setHighspeedCardTps(card.cardId, 100);

    expect(aggregateHighspeedCardMetrics(card.cardId)).toEqual({
      outputTokens: 200,
      durationMs: 4_000,
      regularTps: 75,
      highspeedTps: 100,
      savedDurationMs: 1_000,
    });
  });

  it("waits for card expiry and every started turn before claiming one aggregated share", () => {
    const expiringCard = {
      ...card,
      cardId: "hsc-auto-share-after-expiry",
      taskId: "task-auto-share-after-expiry",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: expiringCard.taskId,
      sourceCommandId: "command-auto-share-1",
      card: expiringCard,
      createdAt: 3,
    });
    recordHighspeedTurn({
      sessionId: expiringCard.taskId,
      sourceCommandId: "command-auto-share-2",
      card: expiringCard,
      createdAt: 4,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-auto-share-1",
      outputTokens: 100,
      durationMs: 1_000,
    });

    expect(listHighspeedCardAutoShareCandidates(expiringCard.taskId)).toEqual([]);
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 100)).toBeNull();

    completeHighspeedTurn({
      sourceCommandId: "command-auto-share-2",
      outputTokens: 50,
      durationMs: 500,
    });
    expect(listExpiredHighspeedCardsAwaitingTps(expiringCard.taskId, 100)).toEqual([
      { cardId: expiringCard.cardId, allTurnsCompleted: true },
    ]);
    setHighspeedCardTps(expiringCard.cardId, 100);
    // 两轮各节省 400ms，合计 800ms / 总耗时 1500ms → 约 1.53x，超过 1.2x 发布门槛，
    // 保证本用例验证的是「到期 + 全部完成 + claim 一次」机制，而不是被资格门禁挡下。
    markHighspeedTurnMetricsPersisted("command-auto-share-1", 400);
    markHighspeedTurnMetricsPersisted("command-auto-share-2", 400);

    expect(resolveNextHighspeedAutoShareAt(expiringCard.taskId)).toBe(100);
    expect(listHighspeedCardAutoShareCandidates(expiringCard.taskId)).toEqual([
      {
        cardId: expiringCard.cardId,
        expiresAt: 100,
        metrics: {
          outputTokens: 150,
          durationMs: 1_500,
          regularTps: 75,
          highspeedTps: 100,
          savedDurationMs: 800,
        },
      },
    ]);
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 99)).toBeNull();
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 100)).not.toBeNull();
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 101)).toBeNull();
    expect(getHighspeedTurnByCommandId("command-auto-share-1")).toMatchObject({
      autoShareAttemptedAt: 100,
    });
    expect(getHighspeedTurnByCommandId("command-auto-share-2")).toMatchObject({
      autoShareAttemptedAt: 100,
    });

    markHighspeedCardAutoShared(expiringCard.cardId, 110);
    expect(getHighspeedTurnByCommandId("command-auto-share-1")).toMatchObject({
      autoSharedAt: 110,
    });
    expect(getHighspeedTurnByCommandId("command-auto-share-2")).toMatchObject({
      autoSharedAt: 110,
    });
  });

  it("does not create an auto-share candidate when the overall speedup stays at or below 1.2x", () => {
    const lowCard = {
      ...card,
      cardId: "hsc-below-speedup-auto-share",
      taskId: "task-below-speedup-auto-share",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: lowCard.taskId,
      sourceCommandId: "command-below-speedup",
      card: lowCard,
      createdAt: 1,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-below-speedup",
      outputTokens: 120,
      durationMs: 1_000,
    });
    setHighspeedCardTps(lowCard.cardId, 100);
    // 节省 100ms / 1000ms → 约 1.1x，未达 1.2x 发布门槛：卡有输出、有 TPS、已持久化，
    // 唯一被挡下的原因就是资格门禁，验证「未达标不弹左下角卡」（spec §9）。
    markHighspeedTurnMetricsPersisted("command-below-speedup", 100);

    expect(listHighspeedCardAutoShareCandidates(lowCard.taskId)).toEqual([]);
  });

  it("does not create an auto-share candidate when the entire card produced zero output", () => {
    const emptyCard = {
      ...card,
      cardId: "hsc-empty-auto-share",
      taskId: "task-empty-auto-share",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: emptyCard.taskId,
      sourceCommandId: "command-empty-auto-share",
      card: emptyCard,
      createdAt: 1,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-empty-auto-share",
      outputTokens: 0,
      durationMs: 100,
    });
    setHighspeedCardTps(emptyCard.cardId, 100);
    markHighspeedTurnMetricsPersisted("command-empty-auto-share", 0);

    expect(listHighspeedCardAutoShareCandidates(emptyCard.taskId)).toEqual([]);
    expect(claimHighspeedCardAutoShare(emptyCard.cardId, 100)).toBeNull();
  });
});
