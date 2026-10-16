// 可复用工作流的两道确认窗在 v4 投影上的边界（docs/dynamic-workflow/launch.md）。
//
// 整个文件钉的是同一条决策：saved run 的脚本与 SaveWorkflow 的落点/覆盖判定全部走**归一化
// 入参**，display 一个字段都不加。选它而不是 display 的理由在 spec 的「版本偏斜边界」：入参
// 通道对每个客户端版本都是无 schema 的透传（v4 侧 `detail: z.unknown()`，legacy v3 侧
// `input: z.unknown()`），而 display 上的新字段旧客户端读不到——saved run 会在一个不显示
// 任何代码的窗口上被批准，不变式 1「保存不产生信任」当场失守。
import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { builtInTools } from "@zcode/core";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

// ── 事件序列构造器（形态同 product-projection.test.ts）──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: SessionEventTypeUnion, payload: unknown, turnId = "turn-1"): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function project(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

/** pendingInteractions[0] 的 permission 载荷；非 permission 直接判失败，避免可选链吞掉断言。 */
function permissionPayload(projection: ProductProjection) {
  const payload = projection.getSnapshot().pendingInteractions[0]?.payload;
  expect(payload?.kind).toBe("permission");
  if (payload?.kind !== "permission") throw new Error("unreachable");
  return payload;
}

function gateEvents(options: {
  toolName: string;
  input: unknown;
  reason: string;
  display?: unknown;
  optionsPolicy?: string;
}): SessionEvent[] {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
  log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run it" });
  log.push(SessionEventType.ToolCallScheduled, {
    toolCallId: "tc-1",
    toolName: options.toolName,
    input: options.input,
    schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
  });
  log.push(SessionEventType.PermissionRequested, {
    requestId: "req-1",
    toolCallId: "tc-1",
    toolName: options.toolName,
    riskLevel: "low",
    reason: options.reason,
    input: options.input,
    ...(options.optionsPolicy === undefined ? {} : { optionsPolicy: options.optionsPolicy }),
    ...(options.display === undefined ? {} : { display: options.display }),
  });
  return log.events;
}

// ── 夹具：两个工具各自的**归一化**入参（executor 的 resolveInput 产出的那一份）──

const SCRIPT = 'const r = agent("检查员");\nreturn await r.ask<string>("检查一遍");';

/** CreateWorkflow saved 源：`{name, script, saved:{name, args, path, scope}}`。 */
const SAVED_RUN_INPUT = {
  name: "release-check",
  script: SCRIPT,
  saved: {
    name: "release-check",
    // 四种声明类型都放进来：实参袋要能整份穿过协议，而不是只有字符串活得下来。
    args: {
      target: "packages/core",
      depth: 3,
      skipTests: false,
      matrix: { os: ["mac", "win"], strict: true },
    },
    path: "/repo/.zcode/workflows/release-check.dwf.ts",
    scope: "project",
  },
};

/** 内联源：同一段脚本，`saved` 缺席。两条路径的 gate 必须只差这一个键。 */
const INLINE_RUN_INPUT = { name: "release-check", script: SCRIPT };

const WORKFLOW_DISPLAY = {
  kind: "create_workflow",
  ok: true,
  errorCount: 0,
  diagnostics: [],
  causalityGraph: {
    steps: [
      {
        id: "ask#1",
        kind: "ask",
        label: "检查员",
        line: 2,
        column: 14,
        lane: "actor#1",
      },
    ],
    lanes: [{ id: "actor#1", name: "检查员" }],
    // 第二层是子代理导向：每阶段一张参与者卡 + 交接边（docs/dynamic-workflow/presentation.md）。
    participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
    handoffs: [],
    sink: ["ask#1"],
  },
};

/** SaveWorkflow：`{name, description, whenToUse?, args?, script, path, overwrite, scope}`。 */
const SAVE_INPUT = {
  name: "release-check",
  description: "对本仓库做一次发布前检查",
  whenToUse: "用户说要发版时",
  args: { target: { type: "string", required: true, description: "要检查的包" } },
  script: SCRIPT,
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  overwrite: true,
  scope: "project",
};

/**
 * SaveWorkflow 的 optionsPolicy **从真实的 core 工具声明推导**，而不是在夹具里写死。
 * 推导式与 approval-gate.ts 逐字相同（`askOptions.allowAlways === false` ⇒ no-always-allow）：
 * 有人把 SaveWorkflow 的 allowAlways 改成 true 时，下面那条「没有 always allow」会立刻红，
 * 而不是继续绿着断言一个已经不再发生的载荷。
 */
const saveWorkflowEntry = builtInTools.find(
  (entry) => entry.metadata.name === SAVE_WORKFLOW_TOOL_NAME,
);
const saveWorkflowOptionsPolicy =
  saveWorkflowEntry?.permission?.askOptions?.allowAlways === false ? "no-always-allow" : undefined;

describe("saved 源 CreateWorkflow 的确认窗（v4 投影）", () => {
  function savedGate(): ProductProjection {
    return project(
      gateEvents({
        toolName: CREATE_WORKFLOW_TOOL_NAME,
        input: SAVED_RUN_INPUT,
        reason: "createWorkflow.runConfirmation",
        display: WORKFLOW_DISPLAY,
        optionsPolicy: "no-always-allow",
      }),
    );
  }

  it("归一化入参整份进 detail：解析出的脚本与 saved 来龙去脉都在", () => {
    const payload = permissionPayload(savedGate());

    // 逐字相等，不是"含有"：确认窗展示的就是将要执行的那份事实，多一个键少一个键都是
    // 「批准的是 A、跑的是 B」的开端（不变式 5）。
    expect(payload.detail).toEqual(SAVED_RUN_INPUT);
    expect(payload.toolName).toBe(CREATE_WORKFLOW_TOOL_NAME);
    const detail = payload.detail as typeof SAVED_RUN_INPUT;
    // 旧桌面的既有读取规则（readWorkflowScript(raw.script) / readWorkflowName(raw.name)）
    // 因此**构造上**命中——不是兼容处理。
    expect(detail.script).toBe(SCRIPT);
    expect(detail.name).toBe("release-check");
    expect(detail.saved).toEqual(SAVED_RUN_INPUT.saved);
  });

  it("四种类型的实参整份穿过 v4 快照 schema（detail 是 z.unknown() 的透传）", () => {
    const snapshot = savedGate().getSnapshot();
    const parsed = conversationSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);

    // 解析产物上再取一次：证明"活下来的"是 schema 认可的那一份，而不是只有内存里的对象。
    const roundTripped = parsed.success ? parsed.data.pendingInteractions[0]?.payload : undefined;
    expect(roundTripped?.kind === "permission" && roundTripped.detail).toEqual(SAVED_RUN_INPUT);
  });

  it("Refine 选项按 toolName 合成：saved 与内联两条路径的选项列表逐字相同", () => {
    // 这条是"下一个人把 Refine 合成改成按入参形状判断"的绊线。合成只认
    // toolName === CreateWorkflow；一旦有人改成"只有内联脚本才给 Refine"，
    // saved run 的用户就会丢掉唯一一条把修改意见说回去的通道。
    const savedOptions = permissionPayload(savedGate()).options;
    const inlineOptions = permissionPayload(
      project(
        gateEvents({
          toolName: CREATE_WORKFLOW_TOOL_NAME,
          input: INLINE_RUN_INPUT,
          reason: "createWorkflow.runConfirmation",
          display: WORKFLOW_DISPLAY,
          optionsPolicy: "no-always-allow",
        }),
      ),
    ).options;

    expect(savedOptions.map((option) => option.optionId)).toEqual([
      "allowOnce",
      "deny",
      "workflowRefine",
    ]);
    expect(savedOptions).toEqual(inlineOptions);
    expect(savedOptions.find((option) => option.optionId === "workflowRefine")).toMatchObject({
      kind: "custom",
      label: "Refine",
      response: { decision: "deny" },
    });
  });

  it("display 的字段集合一个都没多（不变式 8：本特性不改任何 display 载荷）", () => {
    const payload = permissionPayload(savedGate());
    // 偏斜绊线的投影侧对应物：saved 的来龙去脉只准住在 detail 里。往 create_workflow
    // display 上加字段会让旧客户端的 strict safeParse 整块校验不过（不是丢一个字段）。
    expect(Object.keys(payload.display ?? {}).sort()).toEqual([
      "causalityGraph",
      "diagnostics",
      "errorCount",
      "kind",
      "ok",
    ]);
    expect(payload.display).not.toHaveProperty("saved");
    expect(JSON.stringify(payload.display)).not.toContain(SAVED_RUN_INPUT.saved.path);
  });
});

describe("SaveWorkflow 的确认窗（v4 投影）", () => {
  function saveGate(input: unknown = SAVE_INPUT): ProductProjection {
    return project(
      gateEvents({
        toolName: SAVE_WORKFLOW_TOOL_NAME,
        input,
        reason: "saveWorkflow.confirmation",
        ...(saveWorkflowOptionsPolicy === undefined
          ? {}
          : { optionsPolicy: saveWorkflowOptionsPolicy }),
      }),
    );
  }

  it("落点、覆盖判定、scope 与完整脚本都在 detail 里", () => {
    const payload = permissionPayload(saveGate());

    expect(payload.toolName).toBe(SAVE_WORKFLOW_TOOL_NAME);
    expect(payload.detail).toEqual(SAVE_INPUT);
    const detail = payload.detail as typeof SAVE_INPUT;
    // 覆盖与否是决策关键信息：批准一次覆盖 = 同意丢掉磁盘上那一份。它必须在窗上，
    // 而唯一对所有客户端版本都成立的通道就是入参。
    expect(detail.overwrite).toBe(true);
    expect(detail.path).toBe("/repo/.zcode/workflows/release-check.dwf.ts");
    expect(detail.scope).toBe("project");
    expect(detail.script).toBe(SCRIPT);
    expect(conversationSnapshotSchema.safeParse(saveGate().getSnapshot()).success).toBe(true);
  });

  it("新建态与覆盖态只差 detail 上的一个布尔（协议不为此分流）", () => {
    const created = permissionPayload(saveGate({ ...SAVE_INPUT, overwrite: false }));
    expect((created.detail as typeof SAVE_INPUT).overwrite).toBe(false);
    // 载荷的其余部分（含选项与 display 缺席）与覆盖态完全一致：新旧之分是渲染层的事。
    expect({ ...created, detail: undefined }).toEqual({
      ...permissionPayload(saveGate()),
      detail: undefined,
    });
  });

  it("不带 display：v1 刻意不加 save_workflow kind", () => {
    // 未知 display kind 在两侧都干净降级，所以将来要加是纯增量（spec 的 Follow-up）。
    // 现在没有它，恰恰是"内容完整"这条性质的来源：一切都在入参里。
    const payload = permissionPayload(saveGate());
    expect("display" in payload).toBe(false);
  });

  it("选项 = 允许一次 + 拒绝：没有 always allow，也没有 Refine", () => {
    // optionsPolicy 由真实 core 声明推导（见文件上方注释）：这条同时钉住
    // askOptions.allowAlways=false 这个结构性关闭（不变式 3）。
    expect(saveWorkflowOptionsPolicy).toBe("no-always-allow");

    const options = permissionPayload(saveGate()).options;
    expect(options.map((option) => option.optionId)).toEqual(["allowOnce", "deny"]);
    expect(options.some((option) => option.kind === "allowAlways")).toBe(false);
    // Refine 是「改脚本再跑一次」的语义，保存窗上没有对应动作；合成只认 CreateWorkflow。
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });
});
