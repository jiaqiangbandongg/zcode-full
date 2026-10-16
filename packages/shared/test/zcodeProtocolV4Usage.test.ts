// M5 ③-3 usage query 黄金测试（L2 传输层）：v4/usage/stats、v4/conversation/usage 的
// 方法名冻结 + 载荷 schema 校验语义（additive 面按黄金测试背书演进）。
import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4ConversationUsageParamsSchema,
  v4ConversationUsageResultSchema,
  v4UsageStatsParamsSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("zcode protocol v4 usage query", () => {
  it("freezes the v4 usage method names", () => {
    // 方法名是 wire 契约：变更 = 破坏性协议改动，必须走新增方法而非改名。
    expect(V4_METHODS.usageStats).toBe("v4/usage/stats");
    expect(V4_METHODS.conversationUsage).toBe("v4/conversation/usage");
  });

  it("accepts the app usage stats params shape and rejects unknown keys", () => {
    expect(
      v4UsageStatsParamsSchema.parse({ range: "7d", timeZone: "Asia/Shanghai" }),
    ).toEqual({ range: "7d", timeZone: "Asia/Shanghai" });
    expect(v4UsageStatsParamsSchema.parse({ range: "30d" })).toEqual({
      range: "30d",
    });
    // strict：与旧 usage/stats 同形，不允许静默携带未知字段（防旧参数误漂移）。
    expect(
      v4UsageStatsParamsSchema.safeParse({ range: "7d", extra: true }).success,
    ).toBe(false);
    expect(v4UsageStatsParamsSchema.safeParse({ range: "1y" }).success).toBe(
      false,
    );
  });

  it("validates conversation usage params and result round-trip", () => {
    expect(
      v4ConversationUsageParamsSchema.parse({ sessionId: "sess_1" }),
    ).toEqual({ sessionId: "sess_1" });
    expect(
      v4ConversationUsageParamsSchema.safeParse({ sessionId: "" }).success,
    ).toBe(false);

    const result = {
      sessionId: "sess_1",
      totalTokens: 42,
      inputTokens: 30,
      outputTokens: 10,
      reasoningTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 3,
      modelErrorCount: 0,
      inputBaselineBySource: { "web-remote-replayable": 5 },
    };
    expect(v4ConversationUsageResultSchema.parse(result)).toEqual(result);
    // 用量字段不允许负数（聚合器不变量）。
    expect(
      v4ConversationUsageResultSchema.safeParse({
        ...result,
        totalTokens: -1,
      }).success,
    ).toBe(false);
  });
});
