// Catalog 派生 case 全集 —— L1 黄金测试（M2 收尾，13-golden-test-mapping §Catalog 分组映射）。
// 产品语义来源：docs/conversation-session-case-catalog.md；测试名携带 catalog case id，
// 供 coverage matrix 审计脚本对账。形态：事件序列进 → ProductProjection → 投影断言出。
//
// 本文件只收 L1 可证明面（phase / queue / availability / inputRouting / marker / rows 结构）。
// 显式不在本文件（登记去向，防止静默漏测）：
//   A10/K03/K10（latestQueryEditPreemptsActiveTurn / latestQueryEditOnly / latestAssistantRetryOnly）、K06/K07（fork/edit 目标行剪枝）、B08-B10（queue 命令操作）
//     —— 行级 RowActions 与 command 接线属 M3，接线时以 command→投影断言补齐；
//   D/E 组 —— edit rewind 与 fork child 投影需要 command inbox + 跨 session 构造，M3；
//   I/N 组 —— config CAS 消费在 command 侧，M3；
//   J 组隔离 —— fault 隔离已由 conversation-topic-publisher 测试覆盖双实例互不影响；
//   O/P/Q/R 组 —— 工具 UI 复杂度 / 折叠交互 / 弹窗 / composer 草稿是 L3 主场。
import { describe, expect, it } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ProductProjection, computeInputRouting } from "../src/zcode-protocol-v4/index.js";

// ── 事件序列构造器（与 product-projection.test.ts 同构的精简版）──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  constructor(private readonly sessionId = "session-1") {}

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }

  created(contextWindow = 200_000): void {
    this.push(SessionEventType.SessionCreated, { mode: "default", contextWindow });
  }

  turnStarted(turnId: string, input = "hi"): void {
    this.push(SessionEventType.TurnStarted, { turnNumber: 1, input }, { turnId });
  }

  turnComplete(turnId: string, resultType: "success" | "cancelled" = "success"): void {
    this.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 100, resultType },
      { turnId },
    );
  }

  steerQueued(
    turnId: string,
    pendingInputId: string,
    input: string,
    commandKind?: "sendGoalCommand" | "compact",
  ): void {
    this.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId,
        input,
        inputPreview: input,
        inputSize: input.length,
        ...(commandKind ? { commandKind } : {}),
        targetTurnId: turnId,
        queueLength: 0,
      },
      { turnId },
    );
  }

  compact(
    status: "started" | "retrying" | "completed" | "failed" | "interrupted",
    opts: {
      operationId?: string;
      trigger?: "manual" | "auto";
      preCompactTokenCount?: number;
      postCompactTokenCount?: number;
    } = {},
  ): void {
    const type =
      status === "started" || status === "retrying"
        ? SessionEventType.CompactStarted
        : status === "completed"
          ? SessionEventType.CompactCompleted
          : SessionEventType.CompactFailed;
    this.push(type, {
      operationId: opts.operationId ?? "op-1",
      messageId: "msg-1",
      status,
      trigger: opts.trigger ?? "manual",
      display: "separator",
      ...(opts.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: opts.preCompactTokenCount }
        : {}),
      ...(opts.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: opts.postCompactTokenCount }
        : {}),
    });
  }

  goalSet(objective: string, previousObjective?: string): void {
    this.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget(objective, "active"),
      previousTarget: previousObjective ? goalTarget(previousObjective, "active") : null,
    });
  }
}

function goalTarget(objective: string, status: string) {
  return {
    sessionID: "session-1",
    targetID: `target-${objective}`,
    objective,
    summaryTitle: null,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 0, updated: 0 },
  };
}

function project(log: EventLog): ProductProjection {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of log.events) projection.applyEvent(event);
  return projection;
}

function compactMarkers(projection: ProductProjection) {
  return projection
    .getSnapshot()
    .rows.window.flatMap((row) =>
      row.kind === "timelineMarker" && row.marker.type === "compact" ? [row.marker] : [],
    );
}

// ── A 组：首发和运行中输入 ──

describe("catalog A 组：首发和运行中输入", () => {
  it("A01：draft 输入 startNow；首发后进入 running", () => {
    const log = new EventLog();
    log.created();
    const draftOnly = project(log);
    expect(draftOnly.getSnapshot().control.phase).toBe("draft");
    expect(draftOnly.getSnapshot().inputRouting.mode).toBe("startNow");

    log.turnStarted("turn-1", "这是个什么项目");
    const running = project(log);
    expect(running.getSnapshot().control.phase).toBe("running");
    const userInput = running.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(userInput).toMatchObject({ text: "这是个什么项目" });
  });

  it("A02：prewarming 期输入 enqueue（派生规则；prewarming 事件接线属 M3）", () => {
    expect(
      computeInputRouting(
        {
          phase: "prewarming",
          goalStatus: null,
          compacting: false,
          goalVerifying: false,
          queueLength: 0,
          autoDrain: true,
        },
        "queue",
      ),
    ).toEqual({ mode: "enqueue" });
  });

  it("A03/A04/A05/A06：running 期连续输入 —— queue 0→1→2→3+ 保持 FIFO", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    const projection = project(log);
    expect(projection.getSnapshot().inputRouting.mode).toBe("enqueue");

    const texts = ["第一条", "第二条", "第三条", "第四条"];
    for (const [index, text] of texts.entries()) {
      const extra = new EventLog();
      extra.steerQueued("turn-1", `pi-${index + 1}`, text);
      // 借同一 projection 连续喂事件（seq 由断言侧忽略）。
      projection.applyEvent({
        ...extra.events[0],
        sequenceNumber: 100 + index,
      });
      expect(projection.getSnapshot().queue.items).toHaveLength(index + 1);
    }
    expect(projection.getSnapshot().queue.items.map((item) => item.text)).toEqual(texts);
    // running + queue>0 仍是 enqueue（held 只在 completed 下派生）。
    expect(projection.getSnapshot().inputRouting.mode).toBe("enqueue");
  });

  it("A07/M03：running 期 /goal 同走 enqueue（消费时 set/update goal）", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    const snapshot = project(log).getSnapshot();
    // /goal 与普通文本同一 inputRouting 裁决面（kind=sendGoalCommand 的 queue 语义随 command 接线）。
    expect(snapshot.inputRouting.mode).toBe("enqueue");
  });

  it("A08/K04/M04：running 期 /compact 作为 typed intent 入队，不立即执行", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-compact", "/compact", "compact");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.availability.compact).toEqual({ allowed: true });
    expect(snapshot.queue.items).toEqual([
      expect.objectContaining({
        queueItemId: "pi-compact",
        kind: "compact",
        text: "/compact",
      }),
    ]);
    expect(
      snapshot.rows.window.some((row) => row.kind === "userInput" && row.text === "/compact"),
    ).toBe(false);
  });

  it("A09：running 期 fork 稳定 assistant —— 父 queue/activeWork 保留，父时间线不显示 forkCreated（S7）", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "留在父 session 的意图");
    log.push(SessionEventType.SessionForked, {
      originalSessionId: "session-1",
      forkedSessionId: "session-2",
      forkPointMessageId: "msg-1",
    });
    const snapshot = project(log).getSnapshot();
    expect(snapshot.control.phase).toBe("running");
    expect(snapshot.control.activeWorks).toEqual([
      expect.objectContaining({ kind: "primaryTurn" }),
    ]);
    expect(snapshot.queue.items).toHaveLength(1);
    // S7（16-plan，2026-07-08 裁决）：fork 关系只在 sessions 树体现，父时间线零入侵
    //（旧 forkCreated 是「渲染 null」的隐形行）。child 首部 forkNotice 不变。
    expect(
      snapshot.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "forkCreated",
      ),
    ).toBeUndefined();
  });
});

// ── B 组：Stop 和队列保留 ──

describe("catalog B 组：stop 和队列保留", () => {
  function stopWithQueue(queueSize: number): ProductProjection {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    for (let index = 0; index < queueSize; index += 1) {
      log.steerQueued("turn-1", `pi-${index + 1}`, `排队 ${index + 1}`);
    }
    log.turnComplete("turn-1", "cancelled");
    return project(log);
  }

  it("B01：stop（queue=0）→ completed(interrupted)，queue 仍为 0，输入 startNow", () => {
    const snapshot = stopWithQueue(0).getSnapshot();
    expect(snapshot.control.phase).toBe("completedInterrupted");
    expect(snapshot.queue.items).toHaveLength(0);
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("B02/B03/B04：stop（queue=1/2/3+）→ queue 原样保留，autoDrain=false，不自动消费", () => {
    for (const size of [1, 2, 3]) {
      const snapshot = stopWithQueue(size).getSnapshot();
      expect(snapshot.control.phase).toBe("completedInterrupted");
      expect(snapshot.queue.items).toHaveLength(size);
      expect(snapshot.queue.autoDrain).toBe(false);
      // FIFO 原样：文本顺序与入队顺序一致。
      expect(snapshot.queue.items.map((item) => item.text)).toEqual(
        Array.from({ length: size }, (_, index) => `排队 ${index + 1}`),
      );
    }
  });

  it("B05：completed(interrupted) + queue=0 → 输入 startNow（立即开始下一轮）", () => {
    const snapshot = stopWithQueue(0).getSnapshot();
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("B06/B07：held（completed(interrupted) + queue>0 + autoDrain=false）→ 输入 choice，不静默入队", () => {
    // 2026-07-05 重裁决 heldQueueInputRequiresChoice：sendText 与 /goal 统一走 choice。
    const snapshot = stopWithQueue(2).getSnapshot();
    expect(snapshot.inputRouting).toEqual({
      mode: "choice",
      reasonCode: "heldQueueInputRequiresChoice",
    });
  });

  it("B11（事件面）：held queue 删除项后 queue 变化即时重算 —— 清空回 startNow", () => {
    const projection = stopWithQueue(1);
    projection.applyEvent({
      id: "event-late" as EventId,
      sessionId: "session-1" as SessionId,
      turnId: "turn-1" as TurnId,
      type: SessionEventType.TurnSteerDiscarded,
      timestamp: new Date(),
      traceId: "trace-1" as TraceId,
      sequenceNumber: 999,
      payload: { pendingInputIds: ["pi-1"], reason: "user_deleted" },
    } as SessionEvent);
    const snapshot = projection.getSnapshot();
    expect(snapshot.queue.items).toHaveLength(0);
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });
});

// ── C 组：Completed 成功态 ──

describe("catalog C 组：completed 成功态", () => {
  it("C01/C03：assistant complete → completed(success)；queue=0 输入 startNow", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.control.phase).toBe("completedSuccess");
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("C02：queue>0 + autoDrain=true —— 完成后自动消费队首（drain 事件面）", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "接着做");
    log.turnComplete("turn-1", "success");
    // 成功完成不动 autoDrain（只有 stop 置 false）→ runtime 自动 drain 队首。
    const beforeDrain = project(log).getSnapshot();
    expect(beforeDrain.queue.autoDrain).toBe(true);
    // 自动消费在事件面表现为 drained + 新 turn。
    log.push(
      SessionEventType.TurnSteerDrained,
      { pendingInputIds: ["pi-1"] },
      { turnId: "turn-1" },
    );
    log.turnStarted("turn-2", "接着做");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.queue.items).toHaveLength(0);
    expect(snapshot.control.phase).toBe("running");
  });

  it("C02 补强（queuedPromptMessagePreserved）：drained 排队输入必须落为可见 userInput row", () => {
    // Bugfix 回归（2026-07-06 case catalog 战役）：此前 onTurnSteerDrained 只删 queue
    // row，drain 进当前 turn 的用户文本在 live 视图凭空消失（只见 assistant 回复）。
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1", "第一个问题");
    log.steerQueued("turn-1", "pi-1", "排队的第二个问题");
    // runtime 在同一 turn 的下一个 roundtrip 前 drain（无新 TurnStarted）。
    log.push(
      SessionEventType.TurnSteerDrained,
      { pendingInputIds: ["pi-1"] },
      { turnId: "turn-1" },
    );
    const snapshot = project(log).getSnapshot();
    expect(snapshot.queue.items).toHaveLength(0);
    const userRows = snapshot.rows.window.filter((row) => row.kind === "userInput");
    expect(userRows.map((row) => row.kind === "userInput" && row.text)).toEqual([
      "第一个问题",
      "排队的第二个问题",
    ]);
  });

  it("C04：completed 后 /goal → 设置 goal；goalSet 是 stateOnly 不产 row（S10）", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.goalSet("修完登录流程");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.goal).toMatchObject({
      objective: "修完登录流程",
      status: "active",
    });
    // S10（16-plan，2026-07-08 裁决）：目标由 goal 面板承载，timeline 不显示
    //（旧 goalSet marker 是「渲染 null」的隐形行，污染 turn 分组）。
    expect(
      snapshot.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalSet",
      ),
    ).toBeUndefined();
  });

  it("C05：completed 后手动 compact → activeWorks 进 compact，marker running", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.compact("started");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.control.activeWorks).toEqual([expect.objectContaining({ kind: "compact" })]);
    expect(compactMarkers(project(log))[0]).toMatchObject({
      origin: "manual",
      status: "running",
    });
  });

  it("C08：completed(success) + held queue → 输入 choice（同 B06）", () => {
    const log = new EventLog();
    log.created();
    // 第一轮 stop 形成 held（autoDrain=false）。
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "held 意图");
    log.turnComplete("turn-1", "cancelled");
    // 第二轮成功完成（用户 keepQueueAndSend 语义）：queue 仍在、autoDrain 仍 false。
    log.turnStarted("turn-2", "保留 queue 立即发送的这条");
    log.turnComplete("turn-2", "success");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.control.phase).toBe("completedSuccess");
    expect(snapshot.queue.items).toHaveLength(1);
    expect(snapshot.queue.autoDrain).toBe(false);
    expect(snapshot.inputRouting).toEqual({
      mode: "choice",
      reasonCode: "heldQueueInputRequiresChoice",
    });
  });

  it("C09：held queue 下 compact → queue 保留；compact 结束后仍不自动消费", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "held 意图");
    log.turnComplete("turn-1", "cancelled");
    log.compact("started");
    log.compact("completed", { preCompactTokenCount: 800, postCompactTokenCount: 300 });
    const snapshot = project(log).getSnapshot();
    expect(snapshot.queue.items).toHaveLength(1);
    expect(snapshot.queue.autoDrain).toBe(false);
    expect(snapshot.inputRouting.mode).toBe("choice");
  });
});

// ── F 组：手动 Compact ──

describe("catalog F 组：手动 compact", () => {
  function completedThenCompact(queueSize = 0): EventLog {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    for (let index = 0; index < queueSize; index += 1) {
      log.steerQueued("turn-1", `pi-${index + 1}`, `排队 ${index + 1}`);
    }
    log.turnComplete("turn-1", queueSize > 0 ? "cancelled" : "success");
    log.compact("started");
    return log;
  }

  it("F01/F02：手动 compact → compacting(origin=manual)，timeline started", () => {
    const projection = project(completedThenCompact());
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.activeWorks).toEqual([expect.objectContaining({ kind: "compact" })]);
    expect(compactMarkers(projection)[0]).toMatchObject({
      origin: "manual",
      status: "running",
    });
  });

  it("F03：held queue 下手动 compact → queue 保留，autoDrain=false", () => {
    const snapshot = project(completedThenCompact(2)).getSnapshot();
    expect(snapshot.queue.items).toHaveLength(2);
    expect(snapshot.queue.autoDrain).toBe(false);
  });

  it("F04/F05/H05：compacting 期输入（普通文本 / /goal）→ enqueue，不打断 compact", () => {
    // 2026-07-05 重裁决 compactingAcceptsFutureInput（替代原 reject）。
    const snapshot = project(completedThenCompact()).getSnapshot();
    expect(snapshot.inputRouting).toEqual({
      mode: "enqueue",
      reasonCode: "compactingAcceptsFutureInput",
    });
  });

  it("F06/K05/G07：compacting 期再次 compact 被拒 —— compactOperationLock", () => {
    const snapshot = project(completedThenCompact()).getSnapshot();
    expect(snapshot.availability.compact).toEqual({
      allowed: false,
      reasonCode: "compactOperationLock",
    });
  });

  it("F07：compact 被 stop → marker cancelled，compacting 解除", () => {
    const log = completedThenCompact();
    log.compact("interrupted");
    const projection = project(log);
    expect(compactMarkers(projection)[0]).toMatchObject({ status: "cancelled" });
    expect(projection.getSnapshot().control.activeWorks).toEqual([]);
  });

  it("F08：compact success → marker success，usage.contextWindow 回落", () => {
    const log = completedThenCompact();
    log.compact("completed", { preCompactTokenCount: 900, postCompactTokenCount: 250 });
    const projection = project(log);
    expect(compactMarkers(projection)[0]).toMatchObject({
      status: "success",
      tokensBefore: 900,
      tokensAfter: 250,
    });
    expect(projection.getSnapshot().usage.contextWindow?.usedTokens).toBe(250);
    // compacting 解除，输入恢复 startNow。
    expect(projection.getSnapshot().inputRouting.mode).toBe("startNow");
  });

  it("F09：compact failed → marker failed；session 保持 completed；queue 原样、autoDrain 不变", () => {
    const log = completedThenCompact(1);
    log.compact("failed");
    const projection = project(log);
    const snapshot = projection.getSnapshot();
    expect(compactMarkers(projection)[0]).toMatchObject({ status: "failed" });
    // 回到 compact 前的原状态：不 error、不 interrupted 化。
    expect(snapshot.control.phase).toBe("completedInterrupted");
    expect(snapshot.queue.items).toHaveLength(1);
    expect(snapshot.queue.autoDrain).toBe(false);
    // 全部操作恢复：compact 重新可点（retry 入口语义）。
    expect(snapshot.availability.compact).toEqual({ allowed: true });
  });
});

// ── G 组：自动 Compact ──

describe("catalog G 组：自动 compact", () => {
  it("G05/G06：compacting(origin=auto) 期输入 → enqueue", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.compact("started", { trigger: "auto" });
    const projection = project(log);
    expect(compactMarkers(projection)[0]).toMatchObject({ origin: "auto" });
    expect(projection.getSnapshot().inputRouting).toEqual({
      mode: "enqueue",
      reasonCode: "compactingAcceptsFutureInput",
    });
  });

  it("G08/G09/G10：同一 operationId retry —— 单 marker row 状态机 running→…→success", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.compact("started", { trigger: "auto", operationId: "op-auto" });
    log.compact("retrying", { trigger: "auto", operationId: "op-auto" });
    log.compact("retrying", { trigger: "auto", operationId: "op-auto" });
    log.compact("completed", {
      trigger: "auto",
      operationId: "op-auto",
      preCompactTokenCount: 900,
      postCompactTokenCount: 300,
    });
    const projection = project(log);
    const markers = compactMarkers(projection);
    // 全生命周期占同一 marker row：不因 retry 产生多条。
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ origin: "auto", status: "success" });
    expect(projection.getSnapshot().control.activeWorks).toEqual([]);
  });

  it("G12：auto compact 被 stop —— marker cancelled；queue 保留且 autoDrain=false", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "compact 期间追加的");
    log.compact("started", { trigger: "auto" });
    log.compact("interrupted", { trigger: "auto" });
    log.turnComplete("turn-1", "cancelled");
    const projection = project(log);
    const snapshot = projection.getSnapshot();
    expect(compactMarkers(projection)[0]).toMatchObject({ status: "cancelled" });
    expect(snapshot.control.phase).toBe("completedInterrupted");
    expect(snapshot.queue.items).toHaveLength(1);
    expect(snapshot.queue.autoDrain).toBe(false);
  });
});

// ── H 组：Goal ──

describe("catalog H 组：goal", () => {
  it("H01/H02：/goal 设置与更新 —— goal 状态更新，goalSet 不再产 timeline row（S10）", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.goalSet("修完登录流程");
    log.goalSet("再修注册流程", "修完登录流程");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.goal).toMatchObject({ objective: "再修注册流程" });
    // S10：连续两次 set 也不产任何 goalSet row（旧断言两条隐形行已废弃）。
    expect(
      snapshot.rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalSet",
      ),
    ).toEqual([]);
  });

  it("H07：新 target 的 verifier iteration 从 1 重新开始，不串旧 target 轮次", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.turnComplete("turn-1", "success");
    log.goalSet("目标一");
    // 旧 target 两轮验证：第 1 轮未过、第 2 轮通过。
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-目标一",
      status: "started",
      verificationId: "v-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-目标一",
      status: "completed",
      verificationId: "v-1",
      goalIteration: 1,
      verification: { passed: false, reason: "还差单测" },
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-目标一",
      status: "started",
      verificationId: "v-2",
      goalIteration: 2,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-目标一",
      status: "completed",
      verificationId: "v-2",
      goalIteration: 2,
      verification: { passed: true, reason: "ok" },
    });
    // 新 target：iteration/verifications 归零。
    log.goalSet("目标二", "目标一");
    const afterNewTarget = project(log).getSnapshot();
    expect(afterNewTarget.goal).toMatchObject({
      objective: "目标二",
      iteration: 0,
      verifications: [],
    });

    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-目标二",
      status: "started",
      verificationId: "v-3",
      goalIteration: 1,
    });
    const snapshot = project(log).getSnapshot();
    expect(snapshot.goal).toMatchObject({ objective: "目标二", iteration: 1 });
    // 每个 iteration 一条 goalVerify marker（同 iteration 更新同一条）。
    const verifyMarkers = snapshot.rows.window.flatMap((row) =>
      row.kind === "timelineMarker" && row.marker.type === "goalVerify" ? [row.marker] : [],
    );
    expect(verifyMarkers.map((marker) => marker.iteration)).toEqual([1, 2, 1]);
  });
});

// ── M 组：Turn Steer ──

describe("catalog M 组：turn steer", () => {
  it("M01/M02：running（流式/工具中）继续输入 → 只追加 queue，不打断当前 turn", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "流式中", done: false },
      { turnId: "turn-1" },
    );
    log.steerQueued("turn-1", "pi-1", "顺便加个测试");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.queue.items).toHaveLength(1);
    // 当前 turn 不被打断：仍 running、streaming 行保持。
    expect(snapshot.control.phase).toBe("running");
    const assistant = snapshot.rows.window.find((row) => row.kind === "assistantText");
    expect(assistant).toMatchObject({ text: "流式中", state: "streaming" });
  });

  it("M05：交叉输入 —— 文本、/goal 与 /compact 按 admission 顺序进入同一 FIFO", () => {
    const log = new EventLog();
    log.created();
    log.turnStarted("turn-1");
    log.steerQueued("turn-1", "pi-1", "普通文本一");
    log.steerQueued("turn-1", "pi-2", "/goal 修完登录流程", "sendGoalCommand");
    log.steerQueued("turn-1", "pi-3", "/compact", "compact");
    log.steerQueued("turn-1", "pi-4", "普通文本二");
    const snapshot = project(log).getSnapshot();
    expect(snapshot.queue.items.map((item) => item.text)).toEqual([
      "普通文本一",
      "/goal 修完登录流程",
      "/compact",
      "普通文本二",
    ]);
    expect(snapshot.queue.items.map((item) => item.kind)).toEqual([
      "sendText",
      "sendGoalCommand",
      "compact",
      "sendText",
    ]);
    expect(snapshot.availability.compact).toMatchObject({ allowed: true });
  });
});
