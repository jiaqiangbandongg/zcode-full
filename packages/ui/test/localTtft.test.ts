import { describe, expect, it } from "vitest";
import { LocalTtftObserver } from "../src/v4/telemetry/localTtftObserver.js";
import type { LocalTtftRecord } from "@zcode/shared";

describe("Renderer 首输出与乱序归属", () => {
  it("首输出早于 ACK 只收口一次，空开始不触发，正文晚到独立计数", () => {
    let now = 1000;
    const records: LocalTtftRecord[] = [];
    const observer = new LocalTtftObserver(
      (record) => records.push(record),
      () => now,
      () => now,
    );
    observer.enabled = true;
    const context = observer.start("workspace", false)!;
    now = 1010;
    observer.dispatch(context, "workspace", "command");
    observer.calibrate("workspace", {
      instanceId: "cli",
      offsetMs: 0,
      errorMs: 1,
      measuredAt: 1000,
    });
    const facts = {
      ...context,
      instanceId: "cli",
      commandId: "command",
      sessionId: "session",
      turnId: "turn",
      productTurnId: "turn",
      receivedAt: 1020,
      admittedAt: 1030,
      executionAt: 1040,
      requestAt: 1050,
      outputAt: 1100,
      outputKind: "reasoning" as const,
    };
    const base = {
      topic: "conversation/session",
      subscriptionId: "sub",
      sentAt: 1100,
      fromSeq: 0,
      toSeq: 1,
      ttft: facts,
    };
    observer.receive(
      "workspace",
      {
        ...base,
        toSeq: 0,
        ttft: { ...facts, turnId: undefined, productTurnId: undefined, outputAt: undefined },
        payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { revision: 1 } }] },
      },
      "online",
    );
    now = 1110;
    observer.receive(
      "workspace",
      {
        ...base,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 1,
                turnId: "turn",
                createdAt: 1100,
                createdAtSeq: 1,
                kind: "reasoning",
                text: "",
                state: "streaming",
              },
            },
          ],
        },
      },
      "online",
    );
    expect(records.filter((record) => record.kind === "first_output")).toHaveLength(0);
    const output = {
      ...base,
      fromSeq: 1,
      toSeq: 2,
      payload: {
        kind: "deltas" as const,
        deltas: [{ op: "row.delta" as const, rowId: 1, path: "text" as const, append: "thinking" }],
      },
    };
    observer.receive("workspace", output, "online");
    observer.receive("workspace", output, "online");
    observer.ack(context, "accepted");
    expect(records.filter((record) => record.kind === "first_output")).toHaveLength(1);
    expect(records.find((record) => record.kind === "first_output")).toMatchObject({
      start: 1000,
      end: 1110,
      firstOutputKind: "reasoning",
      quality: "complete",
    });
    now = 1200;
    observer.receive(
      "workspace",
      {
        ...base,
        toSeq: 3,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 2,
                turnId: "turn",
                createdAt: 1190,
                createdAtSeq: 3,
                kind: "assistantText",
                text: "answer",
                state: "streaming",
              },
            },
          ],
        },
      },
      "online",
    );
    expect(records.filter((record) => record.kind === "first_text")).toHaveLength(1);
  });
});

it("排队发送和后台返回保留原起点，确认等待有独立区间", () => {
  let now = 1000;
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => now,
    () => now,
  );
  observer.enabled = true;
  const context = observer.start("workspace", true)!;
  expect(context).toBeDefined();
  now = 1010;
  observer.confirmation(context, true);
  now = 1110;
  observer.confirmation(context, false);
  observer.background();
  now = 1200;
  observer.foreground();
  observer.dispatch(context, "workspace", "queued", "session");
  observer.calibrate("workspace", { instanceId: "cli", offsetMs: 0, errorMs: 1, measuredAt: now });
  now = 2000;
  observer.receive(
    "workspace",
    {
      topic: "conversation/session",
      subscriptionId: "sub",
      sentAt: now,
      fromSeq: 0,
      toSeq: 1,
      ttft: {
        ...context,
        instanceId: "cli",
        commandId: "queued",
        sessionId: "session",
        turnId: "turn",
        productTurnId: "turn",
        receivedAt: 1210,
        admittedAt: 1220,
        executionAt: 1800,
        requestAt: 1850,
        outputAt: 1990,
      },
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              kind: "assistantText",
              rowId: 1,
              turnId: "turn",
              createdAt: 1990,
              createdAtSeq: 1,
              text: "answer",
              state: "streaming",
            },
          },
        ],
      },
    },
    "online",
  );
  expect(records.filter((record) => record.kind === "first_output")).toHaveLength(1);
  expect(records.find((record) => record.kind === "first_output")).toMatchObject({
    start: 1000,
    end: 2000,
    sendMode: "queued",
    visibility: "background_returned",
    userWaitMs: 100,
    executionMs: 200,
  });
});

it("阶段检查点不能触发首输出，终态与晚到阶段按原身份补齐", () => {
  let now = 100;
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => now,
    () => now,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  const facts = {
    ...context,
    commandId: "c",
    sessionId: "s",
    instanceId: "cli",
    turnId: "t",
    receivedAt: 100,
    admittedAt: 110,
  };
  now = 150;
  observer.checkpoint("w", facts);
  expect(records.some((record) => record.kind === "checkpoint")).toBe(true);
  expect(records.some((record) => record.kind === "first_output")).toBe(false);
  observer.checkpoint("w", {
    ...facts,
    terminal: "failed",
    details: [
      { id: "ctx", stage: "context", source: "cli", start: 120, end: 140, outcome: "completed" },
    ],
  });
  observer.checkpoint("w", { ...facts, executionAt: 115 });
  expect(records.filter((record) => record.kind === "excluded")).toHaveLength(1);
  expect(records.find((record) => record.kind === "excluded")?.outcome).toBe("failed");
  expect(records.at(-1)?.intervals).toContainEqual({
    stage: "execution_wait",
    start: 110,
    end: 115,
    source: "cli",
  });
});

it("同一内容帧跨越转正边界时，两个原输入分别归因", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const a = observer.start("w", false)!;
  const b = observer.start("w", true)!;
  observer.dispatch(a, "w", "a", "s");
  observer.dispatch(b, "w", "b", "s");
  const facts = (context: typeof a, commandId: string) => ({
    ...context,
    commandId,
    sessionId: "s",
    instanceId: "cli",
    turnId: commandId,
    productTurnId: commandId,
    receivedAt: 100,
    outputAt: 100,
  });
  observer.receive(
    "w",
    {
      topic: "conversation/s",
      subscriptionId: "sub",
      sentAt: 100,
      fromSeq: 0,
      toSeq: 1,
      ttft: facts(a, "a"),
      ttftRelated: [facts(b, "b")],
      payload: {
        kind: "deltas",
        deltas: ["a", "b"].map((id, index) => ({
          op: "row.appended" as const,
          row: {
            kind: "assistantText" as const,
            rowId: index,
            turnId: id,
            createdAt: 100,
            createdAtSeq: 1,
            text: "answer",
            state: "streaming" as const,
          },
        })),
      },
    },
    "online",
  );
  expect(
    records
      .filter((record) => record.kind === "first_output")
      .map((record) => record.commandId)
      .sort(),
  ).toEqual(["a", "b"]);
});

it("休眠/墙钟跳变保留同进程阶段，观察超期只能标未收口", () => {
  let now = 1000;
  let wall = 1000;
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => now,
    () => wall,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  now = 1200;
  wall = 8000;
  observer.checkpoint("w", {
    ...context,
    instanceId: "cli",
    commandId: "c",
    sessionId: "s",
    receivedAt: 1020,
    admittedAt: 1030,
    executionAt: 1050,
  });
  expect(records.at(-1)).toMatchObject({
    quality: "clock_invalid",
    timingReliable: false,
    cliTimingReliable: true,
  });
  expect(records.at(-1)?.intervals).toContainEqual({
    stage: "execution_wait",
    start: 1030,
    end: 1050,
    source: "cli",
  });
  now = 302000;
  wall = now;
  observer.expire();
  expect(records.at(-1)?.outcome).toBe("unclosed");
  expect(records.some((record) => record.outcome === "failed")).toBe(false);
});

it("观测回调异常不影响提交和收口，容量上限有明确分类", () => {
  const observer = new LocalTtftObserver(() => {
    throw new Error("telemetry unavailable");
  });
  observer.enabled = true;
  expect(() => observer.start("w", false)).not.toThrow();
  const records: LocalTtftRecord[] = [];
  const bounded = new LocalTtftObserver((record) => records.push(record));
  bounded.enabled = true;
  for (let i = 0; i < 129; i++) bounded.start("w", false);
  expect(records.filter((record) => record.outcome === "capacity")).toHaveLength(1);
});

it("准备检查点早于 initial 订阅快照时不误判恢复", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  observer.checkpoint("w", {
    ...context,
    instanceId: "cli",
    commandId: "c",
    sessionId: "s",
    turnId: "t",
    receivedAt: 100,
  });
  const snapshot = {
    topic: "conversation/s",
    subscriptionId: "sub",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 100,
    payload: { kind: "snapshot" },
  } as unknown as import("@zcode/shared/zcode-protocol-v4").ConversationTopicFrame;
  observer.receive("w", snapshot, "initial");
  expect(records.some((record) => record.outcome === "recovery")).toBe(false);
  observer.receive("w", snapshot, "recovery");
  expect(records.filter((record) => record.outcome === "recovery")).toHaveLength(1);
});

it("桌面 continuous 的 online snapshot 按 resync 排除，不借用手机 recovery 语义", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  observer.checkpoint("w", {
    ...context,
    instanceId: "cli",
    commandId: "c",
    sessionId: "s",
    turnId: "t",
    receivedAt: 100,
  });
  // publisher 订阅缓冲溢出后首次 flush 用最新 snapshot 代替 deltas，deliveryKind 仍是 online。
  observer.receive(
    "w",
    {
      topic: "conversation/s",
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 100,
      payload: { kind: "snapshot" },
    } as unknown as import("@zcode/shared/zcode-protocol-v4").ConversationTopicFrame,
    "online",
  );
  expect(records.filter((record) => record.kind === "excluded")).toMatchObject([
    { outcome: "resync" },
  ]);
  expect(records.some((record) => record.outcome === "recovery")).toBe(false);
});

it("仅校准过期或缺失时质量为 missing，不把可靠时钟标成 clock_invalid", () => {
  let now = 1000;
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => now,
    () => now,
  );
  observer.enabled = true;
  const context = observer.start("w", true)!;
  now = 1010;
  observer.dispatch(context, "w", "c", "s");
  // 发送时校准过一次；排队等待上一轮结束，首输出在 70 秒后到达，期间没有再校准。
  observer.calibrate("w", { instanceId: "cli", offsetMs: 0, errorMs: 1, measuredAt: 1000 });
  now = 71000;
  observer.receive(
    "w",
    {
      topic: "conversation/s",
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 1,
      sentAt: now,
      ttft: {
        ...context,
        instanceId: "cli",
        commandId: "c",
        sessionId: "s",
        turnId: "t",
        productTurnId: "t",
        receivedAt: 1020,
        admittedAt: 1030,
        executionAt: 65000,
        requestAt: 65100,
        outputAt: 70900,
      },
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              kind: "assistantText",
              rowId: 1,
              turnId: "t",
              createdAt: 70900,
              createdAtSeq: 1,
              text: "answer",
              state: "streaming",
            },
          },
        ],
      },
    },
    "online",
  );
  const output = records.find((record) => record.kind === "first_output");
  expect(output).toMatchObject({
    quality: "missing",
    timingReliable: true,
    cliTimingReliable: true,
    sendMode: "queued",
  });
  expect(output?.intervals.map((interval) => interval.stage)).toEqual([
    "renderer_prepare",
    "execution_wait",
    "request_prepare",
    "model_request",
  ]);
  expect(output?.executionMs).toBeUndefined();
});

it("首输出结果冻结，晚到阶段仍可恢复完整质量且不重复主样本", () => {
  let now = 1000;
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => now,
    () => now,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  now = 1010;
  observer.dispatch(context, "w", "c", "s");
  observer.calibrate("w", { instanceId: "cli", offsetMs: 0, errorMs: 1, measuredAt: 1000 });
  const facts = {
    ...context,
    instanceId: "cli",
    commandId: "c",
    sessionId: "s",
    turnId: "t",
    productTurnId: "t",
    receivedAt: 1011,
    admittedAt: 1012,
    requestAt: 1030,
    outputAt: 1090,
  };
  now = 1100;
  observer.receive(
    "w",
    {
      topic: "conversation/s",
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 1,
      sentAt: now,
      ttft: facts,
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 1,
              turnId: "t",
              createdAt: 1090,
              createdAtSeq: 1,
              kind: "assistantText",
              text: "answer",
              state: "streaming",
            },
          },
        ],
      },
    },
    "online",
  );
  expect(records.find((record) => record.kind === "first_output")?.quality).toBe("missing");
  now = 1200;
  observer.checkpoint("w", { ...facts, executionAt: 1020 });
  expect(records.at(-1)).toMatchObject({ quality: "complete", outcome: "success" });
  expect(records.filter((record) => record.kind === "first_output")).toHaveLength(1);
});

it("明确 CLI 退出按工作区记录中断，不影响其他工作区", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver((record) => records.push(record));
  observer.enabled = true;
  const a = observer.start("a", false)!;
  const b = observer.start("b", false)!;
  observer.interrupt("a");
  expect(
    records
      .filter((record) => record.kind === "excluded")
      .map((record) => [record.observationId, record.outcome]),
  ).toEqual([[a.observationId, "interrupted"]]);
  observer.exclude(b, "cancelled");
  expect(records.at(-1)?.outcome).toBe("cancelled");
});

it("重试更新 requestId，但晚到旧 attempt 不能重置起点或覆盖新身份", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  const facts = {
    ...context,
    commandId: "c",
    sessionId: "s",
    instanceId: "cli",
    turnId: "t",
    receivedAt: 100,
    requestAt: 100,
  };
  observer.checkpoint("w", { ...facts, revision: 1, requestId: "attempt-1" });
  observer.checkpoint("w", { ...facts, revision: 2, requestId: "attempt-2" });
  observer.checkpoint("w", { ...facts, revision: 1, requestId: "attempt-1", executionAt: 100 });
  expect(records.at(-1)).toMatchObject({ requestId: "attempt-2", start: 100 });
});

it("草稿首次绑定 session 后不接受另一 session 的同号阶段", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c");
  const facts = { ...context, commandId: "c", instanceId: "cli", receivedAt: 100, admittedAt: 100 };
  observer.checkpoint("w", { ...facts, sessionId: "original" });
  const count = records.length;
  observer.checkpoint("w", { ...facts, sessionId: "other", executionAt: 100 });
  expect(records).toHaveLength(count);
});

it("首思考后 CLI 中断只结束正文观察，不反转已成立的主 TTFT", () => {
  const records: LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver(
    (record) => records.push(record),
    () => 100,
    () => 100,
  );
  observer.enabled = true;
  const context = observer.start("w", false)!;
  observer.dispatch(context, "w", "c", "s");
  observer.receive(
    "w",
    {
      topic: "conversation/s",
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 100,
      ttft: {
        ...context,
        commandId: "c",
        sessionId: "s",
        instanceId: "cli",
        turnId: "t",
        productTurnId: "t",
        receivedAt: 100,
        outputAt: 100,
      },
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              kind: "reasoning",
              rowId: 1,
              turnId: "t",
              createdAt: 100,
              createdAtSeq: 1,
              state: "streaming",
              text: "thinking",
            },
          },
        ],
      },
    },
    "online",
  );
  observer.interrupt("w");
  observer.interrupt("w");
  expect(records.filter((record) => record.kind === "first_output")).toMatchObject([
    { outcome: "success" },
  ]);
  expect(records.filter((record) => record.kind === "no_text")).toMatchObject([
    { outcome: "interrupted" },
  ]);
  expect(records.filter((record) => record.kind === "excluded")).toHaveLength(0);
});

it("多窗口的同号 command 与不同 CLI 实例不会合并", () => {
  const a: LocalTtftRecord[] = [];
  const b: LocalTtftRecord[] = [];
  const first = new LocalTtftObserver(
    (record) => a.push(record),
    () => 100,
    () => 100,
  );
  const second = new LocalTtftObserver(
    (record) => b.push(record),
    () => 100,
    () => 100,
  );
  first.enabled = second.enabled = true;
  const context = first.start("w", false)!;
  first.dispatch(context, "w", "c");
  const other = second.start("w", false)!;
  second.dispatch(other, "w", "c");
  const facts = {
    ...context,
    commandId: "c",
    instanceId: "cli-a",
    sessionId: "s",
    receivedAt: 100,
  };
  first.checkpoint("w", facts);
  const countA = a.length;
  const countB = b.length;
  first.checkpoint("w", { ...facts, instanceId: "cli-b", executionAt: 100 });
  second.checkpoint("w", facts);
  expect(a).toHaveLength(countA);
  expect(b).toHaveLength(countB);
  second.checkpoint("w", { ...facts, ...other, instanceId: "cli-b" });
  expect(b.at(-1)?.observationId).toBe(other.observationId);
});
