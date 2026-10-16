/**
 * 升级问答桥接的 driver 层用例（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md 的 Slice 1）。
 *
 * 被测对象是 driver 与停驻注册表之间的那条线：铸 qid → 停驻 deferred → 双轨发事件 →
 * 经注册表结算 → 工具结果 = 答案。核心工具面（`escalate` / `ResolveWorkflowQuestion`）与
 * 通知生产不在本切片里，所以这里**直接持 escalatePort 调用**——那正是将来 core 的工具
 * handler 会做的事，端口的形状因此被逐字钉住。
 *
 * 装配刻意最小：一个 executeTurn 永不 resolve 的 stub runtime（模拟一次真实的、被升级问答
 * 阻塞住的 turn）+ 内存 journal。不走 runWorkflowScript——引擎核心对升级零感知，把它拉进来
 * 只会让「谁发的这个事件」变得难以断言。
 */

import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  ESCALATE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  type EscalateQuestionRequest,
  type WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  InMemoryJournalStore,
  type ActorRef,
  type InstanceRef,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { toProtocolEvent } from "../src/app/dynamic-workflow-run-launch.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "../src/app/workflow-escalation-registry.js";
import { fakeFileSystemPort, unsupportedExecutionPort } from "./workflow-driver.helpers.js";

const NOOP_SINK: WorkflowReportSink = {
  askSubmitAttempted: () => {},
  askTurnEnded: () => {},
  askProgress: () => {},
  askStats: () => {},
  askFailed: () => {},
};

const CAPS = { maxConcurrency: 16 };

/** 一次 escalate 调用的请求袋（trace / toolCallId 对本层无语义，只为满足端口契约）。 */
function escalateRequest(question: string, context?: string): EscalateQuestionRequest {
  const sessionId = createSessionId("escalation-test");
  return {
    toolCallId: createToolCallId("escalate-call"),
    question,
    ...(context === undefined ? {} : { context }),
    trace: createRootTraceContext({ sessionId, turnId: createTurnId("escalation-test") }),
  };
}

interface EscalationHarness {
  driver: WorkflowDriver;
  events: RunEvent[];
  journal: InMemoryJournalStore;
  registry: WorkflowEscalationRegistry;
  runId: string;
  /** 建会话 + 派一个 ask，回该会话的升级端口、会话与 ask 实例（升级要求有在飞 ask）。 */
  openAsk(
    ordinal?: number,
    persona?: PersonaSpec,
  ): Promise<{ port: WorkflowEscalatePort; session: SessionRef; instance: InstanceRef }>;
}

function makeHarness(
  options: { registry?: WorkflowEscalationRegistry; runId?: string } = {},
): EscalationHarness {
  const runId = options.runId ?? "dwfrun-11112222-3333-4444";
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId, caps: CAPS, spentTokens: 0, status: "running" });
  const registry = options.registry ?? createWorkflowEscalationRegistry();
  const events: RunEvent[] = [];
  const ports: WorkflowEscalatePort[] = [];

  const driver = createAgentRuntimeWorkflowDriver({
    journal,
    emit: (event) => events.push(event),
    escalationRegistry: registry,
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    cwd: process.cwd(),
    runId,
    runtimeFactory: ({ escalatePort }) => {
      ports.push(escalatePort);
      // turn 永不结束：真实场景里一次停驻的升级正是这样把 turn 挂住的。
      return { executeTurn: () => new Promise(() => {}) } as never;
    },
  })(NOOP_SINK);

  return {
    driver,
    events,
    journal,
    registry,
    runId,
    async openAsk(ordinal = 1, persona: PersonaSpec = {}) {
      const actor: ActorRef = { siteId: "actor#1", ordinal };
      // persona 原样递进去，照引擎的做法（scheduler 把已规范化的 actor.persona 交给 driver）。
      const session = await driver.createActorSession(actor, persona);
      const instance: InstanceRef = { siteId: "ask#1", ordinal };
      driver.startAsk(session, instance, { instructions: "go", typed: false });
      const port = ports[ports.length - 1];
      if (port === undefined) throw new Error("runtimeFactory 没有交出 escalatePort");
      return { port, session, instance };
    },
  };
}

describe("workflow escalation — 停驻与结算", () => {
  it("停驻的问题被作答后，答案原样成为 escalate 的结果", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();

    const pending = port.escalate(escalateRequest("评分上限 95 而门槛 96，这个门是不是坏了？"));
    // 停驻是同步发生的：escalate 一返回 promise，注册表里就该看得见这个问题。
    const parked = harness.registry.pendingFor(harness.runId);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      actor: "actor#1@1",
      question: "评分上限 95 而门槛 96，这个门是不是坏了？",
    });
    expect(parked[0]?.qid).toMatch(/^dwfq-11112222-1$/);
    expect(typeof parked[0]?.askedAt).toBe("number");

    const resolved = harness.registry.resolve(parked[0]!.qid, "门确实坏了，按 95 通过即可。");
    expect(resolved).toEqual({ ok: true, qid: parked[0]!.qid });

    await expect(pending).resolves.toEqual({
      kind: "answered",
      answer: "门确实坏了，按 95 通过即可。",
      qid: parked[0]!.qid,
    });
    // 结算后停驻表就地清空——快照的 pendingQuestions 因此自动收敛。
    expect(harness.registry.pendingFor(harness.runId)).toEqual([]);
  });

  it("askedAt 是提问那一刻的 epoch 毫秒，且事件与停驻记录共用同一个瞬间", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();

    const before = Date.now();
    void port.escalate(escalateRequest("现在几点？")).catch(() => {});
    const after = Date.now();

    const parked = harness.registry.pendingFor(harness.runId)[0]!;
    const event = harness.events[0] as { askedAt?: number };
    expect(parked.askedAt).toBeGreaterThanOrEqual(before);
    expect(parked.askedAt).toBeLessThanOrEqual(after);
    // 同一个瞬间，不是两次相近的取值：实时轨与快照上的「等了多久」因此永不分叉。
    expect(event.askedAt).toBe(parked.askedAt);
  });

  it("context 一并停驻，空白 context 视同缺席", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();

    void port.escalate(escalateRequest("A?", "我试过把门槛调低但脚本是只读的")).catch(() => {});
    void port.escalate(escalateRequest("B?", "   ")).catch(() => {});

    const parked = harness.registry.pendingFor(harness.runId);
    expect(parked[0]?.context).toBe("我试过把门槛调低但脚本是只读的");
    expect(parked[1]).not.toHaveProperty("context");
  });

  it("每个 ask 最多停驻 3 次，第 4 次立即回「预算已尽」的普通结果", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();

    for (let index = 0; index < 3; index++) {
      void port.escalate(escalateRequest(`问题 ${index}`)).catch(() => {});
    }
    expect(harness.registry.pendingFor(harness.runId)).toHaveLength(3);

    // 第 4 次：不停驻、不发事件、不是错误——一条让模型自行推进的普通工具结果。
    const eventsBefore = harness.events.length;
    const fourth = await port.escalate(escalateRequest("问题 3"));

    expect(fourth).toMatchObject({ kind: "refused", reason: "budget_exhausted" });
    // reason 已断言；消息只验可变部分（上限次数）。
    expect(fourth.kind === "refused" && fourth.message).toContain("at most 3 escalations");
    expect(harness.registry.pendingFor(harness.runId)).toHaveLength(3);
    expect(harness.events).toHaveLength(eventsBefore);
  });

  it("预算按 ask 归零，且换 ask 时撤下上一个 ask 的遗留停驻项", async () => {
    const harness = makeHarness();
    const { port, session } = await harness.openAsk();
    const first = [0, 1, 2].map((index) =>
      port.escalate(escalateRequest(`第一个 ask 的问题 ${index}`)),
    );
    await expect(port.escalate(escalateRequest("第 4 次"))).resolves.toMatchObject({
      reason: "budget_exhausted",
    });

    // 同一个会话上派下一个 ask（per-actor FIFO 的常态）：计数归零，遗留停驻项一并撤下——
    // 新 ask 开跑之后，那些问题已经没有听众了，留在表里只会让快照说谎。
    harness.driver.startAsk(session, { siteId: "ask#2", ordinal: 1 }, {
      instructions: "next",
      typed: false,
    });
    await expect(Promise.allSettled(first)).resolves.toMatchObject([
      { status: "rejected" },
      { status: "rejected" },
      { status: "rejected" },
    ]);
    expect(harness.registry.pendingFor(harness.runId)).toEqual([]);

    // 新的 ask 上预算是满的：又能停驻 3 次。
    for (let index = 0; index < 3; index++) {
      void port.escalate(escalateRequest(`第二个 ask 的问题 ${index}`)).catch(() => {});
    }
    expect(harness.registry.pendingFor(harness.runId)).toHaveLength(3);
    await expect(port.escalate(escalateRequest("又是第 4 次"))).resolves.toMatchObject({
      reason: "budget_exhausted",
    });
  });
});

describe("workflow escalation — actor 名", () => {
  it("具名 actor 的名字端到端进入停驻记录与 raised 事件", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk(1, { name: "poet", system: "你写诗。" });

    void port.escalate(escalateRequest("韵脚要不要押到底？")).catch(() => {});

    // 停驻记录（快照 pendingQuestions 的投影源）。
    const parked = harness.registry.pendingFor(harness.runId)[0];
    expect(parked).toMatchObject({ actor: "actor#1@1", actorName: "poet" });
    // 事件轨：结构 ref 与人类名**并存**——前者定位，后者供人读。
    expect(harness.events[0]).toMatchObject({
      type: "escalation-raised",
      actor: { siteId: "actor#1", ordinal: 1 },
      actorName: "poet",
    });
    // durable 轨同形。
    const stored = harness.journal.listEvents(harness.runId, {
      types: "all",
      reportItems: "all",
    })[0];
    expect(stored?.event).toMatchObject({ actorName: "poet" });
  });

  it("匿名 actor 整个字段缺席，不合成任何兜底标签", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk(1, { system: "你没有名字。" });

    void port.escalate(escalateRequest("我是谁？")).catch(() => {});

    const parked = harness.registry.pendingFor(harness.runId)[0];
    expect(parked).not.toHaveProperty("actorName");
    expect(parked?.actor).toBe("actor#1@1");
    expect(harness.events[0]).not.toHaveProperty("actorName");
  });

  it("空串名视同匿名（与引擎的 createActor 判据逐字一致）", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk(1, { name: "" });

    void port.escalate(escalateRequest("空名字算具名吗？")).catch(() => {});

    expect(harness.registry.pendingFor(harness.runId)[0]).not.toHaveProperty("actorName");
  });

  it("只有空白的名字**不**被 trim 成匿名：引擎认它具名、占缓存身份键，这里必须给同一个答案", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk(1, { name: "  " });

    void port.escalate(escalateRequest("我叫两个空格。")).catch(() => {});

    expect(harness.registry.pendingFor(harness.runId)[0]?.actorName).toBe("  ");
  });
});

describe("workflow escalation — 取消", () => {
  it("cancelAsk 一并拒绝停驻中的升级 deferred，之后作答得到 run_not_in_flight", async () => {
    const harness = makeHarness();
    const { port, instance } = await harness.openAsk();

    const pending = port.escalate(escalateRequest("要不要跳过这个检查？"));
    const qid = harness.registry.pendingFor(harness.runId)[0]?.qid;
    expect(qid).toBeDefined();

    harness.driver.cancelAsk(instance);

    // 与 submit deferred 完全同待遇：拒 Cancelled，handler 不再悬挂（这是 spec 里
    // 「无答案 = 无限期阻塞」的唯一逃生舱）。
    await expect(pending).rejects.toMatchObject({ code: "Cancelled" });
    expect(harness.registry.pendingFor(harness.runId)).toEqual([]);
    expect(harness.registry.resolve(qid!, "太晚了")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
  });

  it("cancelAsk 拒绝该会话上**全部**停驻项（一轮里并发升级过几次）", async () => {
    const harness = makeHarness();
    const { port, instance } = await harness.openAsk();

    const pendings = [0, 1, 2].map((index) => port.escalate(escalateRequest(`并发问题 ${index}`)));
    expect(harness.registry.pendingFor(harness.runId)).toHaveLength(3);

    harness.driver.cancelAsk(instance);

    const settled = await Promise.allSettled(pendings);
    expect(settled.map((one) => one.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(harness.registry.pendingFor(harness.runId)).toEqual([]);
  });
});

describe("workflow escalation — qid 唯一性", () => {
  it("两个并发 run 共用一张表时 qid 互不碰撞（片段相同则自动加长）", async () => {
    // 刻意让两个 runId 的前 8 个字符完全一样：短片段会撞，铸造必须自己走到下一个候选。
    const registry = createWorkflowEscalationRegistry();
    const left = makeHarness({ registry, runId: "dwfrun-abcdef01-aaaa" });
    const right = makeHarness({ registry, runId: "dwfrun-abcdef01-bbbb" });

    const leftAsk = await left.openAsk();
    const rightAsk = await right.openAsk();
    void leftAsk.port.escalate(escalateRequest("左边的问题")).catch(() => {});
    void rightAsk.port.escalate(escalateRequest("右边的问题")).catch(() => {});

    const leftQid = registry.pendingFor(left.runId)[0]?.qid;
    const rightQid = registry.pendingFor(right.runId)[0]?.qid;
    expect(leftQid).toBe("dwfq-abcdef01-1");
    // 短片段已被左边占用 ⇒ 退到完整 runId 片段，仍然人类可辨认。
    expect(rightQid).toBe("dwfq-abcdef01-bbbb-1");
    expect(leftQid).not.toBe(rightQid);
  });

  it("同一个 run 内 seq 单调递增", async () => {
    const harness = makeHarness({ runId: "dwfrun-99887766-0000" });
    const { port } = await harness.openAsk();
    for (let index = 0; index < 3; index++) {
      void port.escalate(escalateRequest(`问题 ${index}`)).catch(() => {});
    }

    expect(harness.registry.pendingFor(harness.runId).map((one) => one.qid)).toEqual([
      "dwfq-99887766-1",
      "dwfq-99887766-2",
      "dwfq-99887766-3",
    ]);
  });
});

describe("workflow escalation — 事件双轨", () => {
  it("raised / resolved 两类事件同时落 journal 与 emit 轨，且顺序一致", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();

    const pending = port.escalate(escalateRequest("这个门是不是坏了？", "上下文若干"));
    // 停驻记录要在结算**之前**读：结算会把它从表里摘掉，而下面要拿它的 askedAt 与事件比对。
    const parked = harness.registry.pendingFor(harness.runId)[0]!;
    const qid = parked.qid;
    harness.registry.resolve(qid, "坏了，按 95 通过。");
    await pending;

    // askedAt 取自停驻记录：driver 只读一次时钟，所以两条读面上的提问时刻必须逐位相等——
    // 这条断言就是「不许调两次 Date.now()」的守卫（各调一次会差几毫秒，下面的 toEqual 立刻红）。
    const raised = {
      type: "escalation-raised",
      qid,
      actor: { siteId: "actor#1", ordinal: 1 },
      question: "这个门是不是坏了？",
      context: "上下文若干",
      askedAt: parked.askedAt,
    };
    const resolved = { type: "escalation-resolved", qid, answer: "坏了，按 95 通过。" };

    // 实时轨（driver.emit → progress sink）。
    expect(harness.events).toEqual([raised, resolved]);
    // durable 轨（dwf_event）。升级**不写 dwf_node 行**：等待不是工作量。
    const stored = harness.journal.listEvents(harness.runId, { types: "all", reportItems: "all" });
    expect(stored.map((one) => one.event)).toEqual([raised, resolved]);
    expect(harness.journal.listNodes(harness.runId, { kinds: "all", withResult: true })).toEqual(
      [],
    );
  });

  it("载荷经端口的 2048 字符界裁剪（超长问题不会原样穿过协议边界）", async () => {
    const harness = makeHarness();
    const { port } = await harness.openAsk();
    const huge = "问".repeat(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength + 500);

    void port.escalate(escalateRequest(huge)).catch(() => {});

    const stored = harness.journal.listEvents(harness.runId, { types: "all", reportItems: "all" });
    // journal 里是**原始事实**（未裁剪）——界是协议边界上的事，不是存储层的事。
    expect((stored[0]!.event as { question: string }).question).toHaveLength(huge.length);
    const projected = toProtocolEvent(stored[0]!.sequence, stored[0]!.event);
    expect(projected.type).toBe("escalation-raised");
    expect(projected.truncated).toBe(true);
    expect((projected.payload.question as string).length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
    );
  });
});

describe("workflow escalation — 注册表的结构化拒绝", () => {
  it("三类拒绝各自可分辨，且文案陈述现状", async () => {
    const harness = makeHarness();
    const { port, instance } = await harness.openAsk();

    // (1) 从未存在的 id。
    const unknown = harness.registry.resolve("dwfq-nonesuch-9", "答案");
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_question" });
    expect(unknown.ok === false && unknown.message).toContain("pendingQuestions");

    // (2) 已被回答。
    const answered = port.escalate(escalateRequest("第一个问题"));
    const firstQid = harness.registry.pendingFor(harness.runId)[0]!.qid;
    harness.registry.resolve(firstQid, "答案一");
    await answered;
    const again = harness.registry.resolve(firstQid, "答案二");
    expect(again).toMatchObject({ ok: false, reason: "already_resolved" });

    // (3) 随 ask 一起被撤下。
    const withdrawn = port.escalate(escalateRequest("第二个问题"));
    const secondQid = harness.registry.pendingFor(harness.runId)[0]!.qid;
    harness.driver.cancelAsk(instance);
    await expect(withdrawn).rejects.toMatchObject({ code: "Cancelled" });
    expect(harness.registry.resolve(secondQid, "答案三")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
  });

  it("撤下不覆盖「已回答」：resolved 的 qid 之后仍报 already_resolved", async () => {
    const harness = makeHarness();
    const { port, instance } = await harness.openAsk();

    const answered = port.escalate(escalateRequest("问题"));
    const qid = harness.registry.pendingFor(harness.runId)[0]!.qid;
    harness.registry.resolve(qid, "答案");
    await answered;
    // ask 随后被取消：已退场的 qid 不该被降级成「没人在等」——那会把「答案已送达」
    // 改写成另一个事实。
    harness.driver.cancelAsk(instance);

    expect(harness.registry.resolve(qid, "再来一次")).toMatchObject({
      ok: false,
      reason: "already_resolved",
    });
  });

  it("pendingFor 按 run 隔离：一张表上的两个 run 各看各的", async () => {
    const registry = createWorkflowEscalationRegistry();
    const left = makeHarness({ registry, runId: "dwfrun-aaaa0000-1111" });
    const right = makeHarness({ registry, runId: "dwfrun-bbbb0000-2222" });
    const leftAsk = await left.openAsk();
    const rightAsk = await right.openAsk();

    void leftAsk.port.escalate(escalateRequest("左")).catch(() => {});
    void rightAsk.port.escalate(escalateRequest("右")).catch(() => {});

    expect(registry.pendingFor(left.runId).map((one) => one.question)).toEqual(["左"]);
    expect(registry.pendingFor(right.runId).map((one) => one.question)).toEqual(["右"]);
  });
});

// ————————————————————————————————————————————————
// actor 会话的工具面边界（Slice 2）。
//
// 升级问答有一条**身份**不变式：actor 提问，主代理作答。让另一个 actor 顺手回答，等于把
// 「把判断权交回给创建这条工作流的那一方」悄悄退化成 actor 之间的互相说服——而那恰恰是
// 本特性存在的理由（一个被挡住的 actor 需要的是能改掉那道门的人，不是另一个同样被挡住的人）。
// 所以 `ResolveWorkflowQuestion` 进 actor 的禁用名单，`escalate` 绝不进。
// ————————————————————————————————————————————————
describe("workflow escalation — actor 会话的工具面", () => {
  it("actor 的工具面减掉 ResolveWorkflowQuestion，但不减 escalate", () => {
    const policy = workflowActorToolPolicy();
    expect(policy.toolDisallowlist).toContain(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME);
    expect(policy.toolDisallowlist).not.toContain(ESCALATE_TOOL_NAME);
  });
});
