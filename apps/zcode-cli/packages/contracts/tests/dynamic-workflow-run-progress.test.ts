// 进度投影的契约面：一条引擎 RunEvent → 一条 dynamic_workflow_run_progress 会话事件。
// 这里钉的是**有界化**（bounding）与词汇表，不是投影语义（那在 bootstrap 的
// product-projection 测试里）。见 docs/dynamic-workflow/presentation.md「The run state the pane draws」。
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  SessionEventType,
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunProgressPayload,
} from "../src/index.js";

describe("dynamic workflow run progress 会话事件", () => {
  it("事件类型进入 SessionEventType 词汇表", () => {
    expect(SessionEventType.DynamicWorkflowRunProgress).toBe("dynamic_workflow_run_progress");
  });

  it("payload 类型承载 runId / sequence / eventType 与端口同形的 JSON 载荷", () => {
    const payload: DynamicWorkflowRunProgressPayload = {
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: 7,
      eventType: "node-settled",
      payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
    };
    expect(payload.payload.outcome).toBe("ok");
  });
});

describe("boundDynamicWorkflowRunEventPayload", () => {
  it("小载荷逐字通过，不置 truncated", () => {
    const source = {
      instance: { siteId: "ask#1", ordinal: 2 },
      outcome: "failed",
      error: { code: "ValidationFailed", message: "字段 name 缺失" },
    };
    expect(boundDynamicWorkflowRunEventPayload(source)).toEqual({
      payload: source,
      truncated: false,
    });
  });

  it("超长字符串按上限截断并置 truncated", () => {
    const long = "x".repeat(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength + 100);
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload({ finalText: long });
    expect(truncated).toBe(true);
    expect((payload.finalText as string).length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
    );
  });

  it("截断不切开代理对（surrogate-safe）", () => {
    // 上限位置刚好落在一个 4 字节 emoji 中间：宁可少一个字符，也不产出孤立代理项。
    const emoji = "😀";
    const head = "a".repeat(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength - 1);
    const { payload } = boundDynamicWorkflowRunEventPayload({ text: `${head}${emoji}` });
    const text = payload.text as string;
    expect(text.length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength - 1);
    expect(/[\uD800-\uDFFF]/.test(text)).toBe(false);
  });

  it("超长数组按上限裁剪并置 truncated", () => {
    const violations = Array.from(
      { length: DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxArrayItems + 5 },
      (_, index) => ({ path: `/a/${index}` }),
    );
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload({ violations });
    expect(truncated).toBe(true);
    expect((payload.violations as unknown[]).length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxArrayItems,
    );
  });

  it("过深嵌套在上限处剪断并置 truncated", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxDepth + 3; level += 1) {
      deep = { nested: deep };
    }
    const { truncated } = boundDynamicWorkflowRunEventPayload(deep);
    expect(truncated).toBe(true);
  });

  it("非 JSON 值（Infinity / undefined / 函数）被规范化，绝不产出不可序列化载荷", () => {
    // 任何非有限数经 JSON 都会变成 null；这里一次性折叠，落库前后才结构等价。
    const { payload } = boundDynamicWorkflowRunEventPayload({
      stats: { ratio: Number.POSITIVE_INFINITY, count: 98 },
      absent: undefined,
      fn: () => 1,
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect((payload.stats as Record<string, unknown>).ratio).toBeNull();
    expect(payload).not.toHaveProperty("absent");
    expect(payload).not.toHaveProperty("fn");
  });

  it("键数超上限时只保留前若干键并置 truncated", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxKeys + 4; index += 1) {
      wide[`k${index}`] = index;
    }
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload(wide);
    expect(truncated).toBe(true);
    expect(Object.keys(payload).length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxKeys);
  });
});
