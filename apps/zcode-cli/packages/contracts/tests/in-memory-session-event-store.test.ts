import { describe, expect, it } from "vitest";

import {
  InMemorySessionEventStore,
  SessionEventType,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
} from "../src/index.js";

let eventCounter = 0;
function event(
  sessionId: string,
  type: SessionEventType,
  turnId?: string,
  sequenceNumber = 0,
): SessionEvent {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter}`,
    sessionId,
    type,
    turnId,
    timestamp: new Date(eventCounter),
    traceId: "trace",
    sequenceNumber,
    payload: {},
  } as unknown as SessionEvent;
}

const S = "session_a" as SessionId;

async function runTwoTurns(
  store: SessionEventStorePort,
  deltasPerTurn = 3,
): Promise<SessionEvent[]> {
  const appended: SessionEvent[] = [];
  const push = async (e: SessionEvent) => {
    appended.push(await store.append(e));
  };
  await push(event(S, SessionEventType.SessionCreated));
  await push(event(S, SessionEventType.TurnStarted, "t1"));
  for (let i = 0; i < deltasPerTurn; i += 1) {
    await push(event(S, SessionEventType.ModelStreaming, "t1"));
  }
  await push(event(S, SessionEventType.ModelComplete, "t1"));
  await push(event(S, SessionEventType.TurnComplete, "t1"));
  await push(event(S, SessionEventType.TurnStarted, "t2"));
  for (let i = 0; i < deltasPerTurn; i += 1) {
    await push(event(S, SessionEventType.ModelStreaming, "t2"));
  }
  return appended;
}

describe("InMemorySessionEventStore", () => {
  it("RET-002 序号严格递增，淘汰后 getLatestSequenceNumber 不回退，getEvents 按 seq 有序", async () => {
    const store = new InMemorySessionEventStore();
    const appended = await runTwoTurns(store);
    const seqs = appended.map((e) => e.sequenceNumber);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    const retained = await store.getEvents(S);
    // turn 1 的 3 条 delta 已淘汰，其余全部保留；顺序仍按 seq。
    expect(retained.map((e) => e.sequenceNumber)).toEqual(seqs.filter((seq) => seq < 3 || seq > 5));
    expect(await store.getLatestSequenceNumber(S)).toBe(seqs.length);
    // 淘汰后追加仍从计数器继续，不会复用 seq。
    const next = await store.append(event(S, SessionEventType.ModelComplete, "t2"));
    expect(next.sequenceNumber).toBe(seqs.length + 1);
  });

  it("RET-003 getEventsAfter 只含窗口内瞬态与全部非瞬态；deleteSession 后统计归零", async () => {
    const store = new InMemorySessionEventStore();
    await runTwoTurns(store);
    const after = await store.getEventsAfter(S, 1);
    expect(after.some((e) => e.turnId === "t1" && e.type === SessionEventType.ModelStreaming)).toBe(
      false,
    );
    expect(
      after.filter((e) => e.turnId === "t2" && e.type === SessionEventType.ModelStreaming),
    ).toHaveLength(3);
    expect(after.some((e) => e.type === SessionEventType.ModelComplete)).toBe(true);

    // 11 条追加（SessionCreated + 2×TurnStarted + 6 delta + ModelComplete + TurnComplete），淘汰 turn 1 的 3 条 delta。
    expect(store.getStats()).toEqual({
      sessions: 1,
      events: 8,
      evictedEvents: 3,
      retainedTransient: 3,
    });
    await store.deleteSession(S);
    expect(store.getStats()).toEqual({
      sessions: 0,
      events: 0,
      evictedEvents: 0,
      retainedTransient: 0,
    });
    expect(await store.getLatestSequenceNumber(S)).toBe(0);
  });

  it("RET-004 unbounded 与 turn-window 对同一序列产生完全相同的非瞬态事件与 seq", async () => {
    const bounded = new InMemorySessionEventStore();
    const unbounded = new InMemorySessionEventStore({ retention: "unbounded" });
    eventCounter = 0;
    const a = await runTwoTurns(bounded);
    eventCounter = 0;
    const b = await runTwoTurns(unbounded);
    expect(a.map((e) => e.sequenceNumber)).toEqual(b.map((e) => e.sequenceNumber));

    const nonTransient = (events: SessionEvent[]) =>
      events
        .filter((e) => e.type !== SessionEventType.ModelStreaming)
        .map((e) => [e.type, e.turnId, e.sequenceNumber]);
    expect(nonTransient(await bounded.getEvents(S))).toEqual(
      nonTransient(await unbounded.getEvents(S)),
    );
    expect((await unbounded.getEvents(S)).length).toBe((await bounded.getEvents(S)).length + 3);
    expect(unbounded.getStats().evictedEvents).toBe(0);
  });

  it("RET-005 多 turn 长会话下驻留事件数有界：非瞬态 + 最多两个 turn 的瞬态", async () => {
    const store = new InMemorySessionEventStore();
    const turns = 50;
    const deltas = 200;
    for (let t = 1; t <= turns; t += 1) {
      await store.append(event(S, SessionEventType.TurnStarted, `t${t}`));
      for (let i = 0; i < deltas; i += 1) {
        await store.append(event(S, SessionEventType.ModelStreaming, `t${t}`));
      }
      await store.append(event(S, SessionEventType.ModelComplete, `t${t}`));
      await store.append(event(S, SessionEventType.TurnComplete, `t${t}`));
    }
    const stats = store.getStats();
    const nonTransient = turns * 3;
    expect(stats.events).toBeLessThanOrEqual(nonTransient + 2 * deltas);
    expect(stats.retainedTransient).toBe(deltas);
    expect(stats.evictedEvents).toBe((turns - 1) * deltas);
    expect(await store.getLatestSequenceNumber(S)).toBe(turns * (deltas + 3));
  });

  it("显式 sequenceNumber 优先，计数器取最大值", async () => {
    const store = new InMemorySessionEventStore();
    await store.append(event(S, SessionEventType.SessionCreated, undefined, 10));
    const next = await store.append(event(S, SessionEventType.TurnStarted, "t1"));
    expect(next.sequenceNumber).toBe(11);
  });

  it("接受自定义策略工厂，每个 session 各自一份状态", async () => {
    let created = 0;
    const store = new InMemorySessionEventStore({
      retention: () => {
        created += 1;
        return { onAppend: () => [], collectExpired: () => [] };
      },
    });
    await store.append(event("a", SessionEventType.SessionCreated));
    await store.append(event("b", SessionEventType.SessionCreated));
    await store.append(event("a", SessionEventType.TurnStarted, "t1"));
    expect(created).toBe(2);
  });
});

describe("InMemorySessionEventStore · pruneTransientEvents", () => {
  it("RET-009 一次性 session 的瞬态事件在 grace 后被时间兜底淘汰，序号不回退", async () => {
    let nowMs = 0;
    const store = new InMemorySessionEventStore({ now: () => nowMs });
    const child = "sess_subagent_child" as SessionId;
    await store.append(event(child, SessionEventType.TurnStarted, "c1"));
    for (let i = 0; i < 5; i += 1) {
      await store.append(event(child, SessionEventType.ModelStreaming, "c1"));
    }
    await store.append(event(child, SessionEventType.ModelComplete, "c1"));
    nowMs = 10_000;
    await store.append(event(child, SessionEventType.TurnComplete, "c1"));

    expect(store.pruneTransientEvents(60_000)).toBe(0);
    expect(store.getStats().retainedTransient).toBe(5);
    expect(store.pruneTransientEvents(130_000)).toBe(5);
    expect(store.getStats()).toMatchObject({ events: 3, evictedEvents: 5, retainedTransient: 0 });
    expect(await store.getLatestSequenceNumber(child)).toBe(8);
    expect(store.pruneTransientEvents(200_000)).toBe(0);
  });

  it("RET-009 进行中 turn 的瞬态事件不受时间兜底影响", async () => {
    const store = new InMemorySessionEventStore({ now: () => 0 });
    await store.append(event(S, SessionEventType.TurnStarted, "t1"));
    await store.append(event(S, SessionEventType.ModelStreaming, "t1"));
    expect(store.pruneTransientEvents(10_000_000)).toBe(0);
    expect(store.getStats().retainedTransient).toBe(1);
  });
});

describe("InMemorySessionEventStore · model_request 元数据瘦身", () => {
  function modelRequest(turnId: string, messageCount: number): SessionEvent {
    const base = event(S, SessionEventType.ModelRequest, turnId);
    return {
      ...base,
      payload: {
        messages: Array.from({ length: messageCount }, (_, i) => ({
          role: "user",
          content: `m${i}`,
        })),
        providerId: "p",
        modelId: "m",
        querySource: "repl_main_thread",
        toolCount: 3,
      },
    } as unknown as SessionEvent;
  }

  async function runTwoTurnsWithRequests(store: SessionEventStorePort) {
    const appended: SessionEvent[] = [];
    const push = async (e: SessionEvent) => {
      appended.push(await store.append(e));
    };
    await push(event(S, SessionEventType.TurnStarted, "t1"));
    await push(modelRequest("t1", 4));
    await push(event(S, SessionEventType.TurnComplete, "t1"));
    await push(event(S, SessionEventType.TurnStarted, "t2"));
    await push(modelRequest("t2", 6));
    return appended;
  }

  it("RET-011 下一 turn 开始后淘汰的 turn 只保留 messageCount，进行中 turn 与 append 返回值保持完整", async () => {
    const store = new InMemorySessionEventStore();
    const appended = await runTwoTurnsWithRequests(store);
    const requests = (await store.getEvents(S)).filter(
      (e) => e.type === SessionEventType.ModelRequest,
    );
    expect(requests).toHaveLength(2);
    const [sealed, open] = requests;
    expect(sealed?.sequenceNumber).toBe(appended[1]?.sequenceNumber);
    expect(sealed?.payload).toEqual({
      messageCount: 4,
      providerId: "p",
      modelId: "m",
      querySource: "repl_main_thread",
      toolCount: 3,
    });
    expect((open?.payload as { messages: unknown[] }).messages).toHaveLength(6);
    // live sink 拿到的是 append 返回值，必须仍含完整上下文（debug JSONL 依赖）。
    expect((appended[1]?.payload as { messages: unknown[] }).messages).toHaveLength(4);
  });

  it("RET-011 时间兜底淘汰一次性 session 时同样瘦身", async () => {
    let now = 0;
    const store = new InMemorySessionEventStore({ now: () => now });
    await store.append(event(S, SessionEventType.TurnStarted, "t1"));
    await store.append(modelRequest("t1", 2));
    await store.append(event(S, SessionEventType.TurnComplete, "t1"));
    now = 10 * 60_000;
    store.pruneTransientEvents();
    const [request] = (await store.getEvents(S)).filter(
      (e) => e.type === SessionEventType.ModelRequest,
    );
    expect(request?.payload).not.toHaveProperty("messages");
    expect(request?.payload).toMatchObject({ messageCount: 2 });
  });

  it("RET-011 unbounded 模式不瘦身", async () => {
    const store = new InMemorySessionEventStore({ retention: "unbounded" });
    await runTwoTurnsWithRequests(store);
    const requests = (await store.getEvents(S)).filter(
      (e) => e.type === SessionEventType.ModelRequest,
    );
    expect(requests.map((e) => (e.payload as { messages: unknown[] }).messages.length)).toEqual([
      4, 6,
    ]);
  });
});
