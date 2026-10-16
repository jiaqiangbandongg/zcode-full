import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
  normalizeProviderLimitedBannerMessage,
  resolveQuotaBannerUpgradeProviderId,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function entitlement(params: {
  dailyRemaining: number;
  modelRemaining: number;
}): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: {
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      name: "Z.AI Start Plan",
    },
    remaining: {
      count: params.dailyRemaining,
      isShow: true,
      percentage: params.dailyRemaining / 500,
    },
    subscription: null,
    quota: {
      level: "Start",
      limits: [
        {
          type: "glm-5.2",
          bucketId: "bucket-glm-52",
          periodStart: 0,
          periodEnd: 1000,
          number: 100,
          remaining: params.modelRemaining,
          percentage: params.modelRemaining / 100,
          usageDetails: [{ modelCode: "glm-5.2", usage: 100 - params.modelRemaining }],
        },
      ],
    },
  };
}

describe("V4 session quota banner state", () => {
  it("只保留 10% 和耗尽提醒，且不阻断提交", () => {
    const cases = [
      [50, null, false],
      [48, null, false],
      [47, null, false],
      [20, null, false],
      [10.1, null, false],
      [10, "model-very-low", true],
      [9, "model-very-low", true],
      [0, "daily-exhausted", false],
    ] as const;
    for (const [remaining, kind, dismissible] of cases) {
      const state = buildSessionQuotaBannerState({
        activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        snapshot: entitlement({
          dailyRemaining: 450,
          modelRemaining: remaining,
        }),
        modelId: "glm-5.2",
      });
      expect(state.kind).toBe(kind);
      expect(state.dismissible).toBe(dismissible);
      expect(state.blocksSubmit).toBe(false);
    }
  });

  it("服务端并发和额度错误优先于 entitlement，dismiss key 隔离错误实例", () => {
    const state = buildSessionQuotaBannerState({
      activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      snapshot: entitlement({ dailyRemaining: 450, modelRemaining: 50 }),
      modelId: "glm-5.2",
      serverConcurrentLimited: true,
      serverConcurrentLimitBusinessCode: "3010",
      serverConcurrentLimitReason: "retry-exhausted-busy",
    });
    expect(state.kind).toBe("concurrent-limit");
    expect(state.priority).toBe(60);
    expect(buildSessionQuotaBannerDismissKey(state, "error-a")).not.toBe(
      buildSessionQuotaBannerDismissKey(state, "error-b"),
    );
  });

  it("官方 MCP 不可用时按 code 分流，且不阻断输入", () => {
    const quotaState = buildSessionQuotaBannerState({
      activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      snapshot: null,
      modelId: "glm-5.2",
      mcpUnavailableNotice: {
        code: "quota_exceeded",
        rowId: 12,
        serverName: "zcode-official",
        toolName: "search_image",
      },
    });
    expect(quotaState.kind).toBe("mcp-quota-exhausted");
    expect(quotaState.mcpServerName).toBe("zcode-official");
    expect(quotaState.dismissible).toBe(true);
    expect(quotaState.blocksSubmit).toBe(false);

    const planState = buildSessionQuotaBannerState({
      activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      snapshot: null,
      modelId: "glm-5.2",
      mcpUnavailableNotice: {
        code: "coding_plan_required",
        rowId: 12,
        serverName: "zcode-official",
        toolName: "search_image",
      },
    });
    expect(planState.kind).toBe("mcp-plan-required");
  });

  it("今日额度用完不给升级入口，权益缺失才给", () => {
    // 额度用完只能等自然日重置，升级按钮会让用户以为花钱就能立刻继续。
    expect(shouldOfferQuotaBannerUpgrade("mcp-quota-exhausted")).toBe(false);
    expect(shouldOfferQuotaBannerUpgrade("mcp-plan-required")).toBe(true);
    // 既有 kind 的升级入口不受影响。
    expect(shouldOfferQuotaBannerUpgrade("daily-exhausted")).toBe(true);
    expect(shouldOfferQuotaBannerUpgrade("provider-limited")).toBe(true);
    expect(shouldOfferQuotaBannerUpgrade(null)).toBe(true);
  });

  it("模型额度问题优先于 MCP 提示", () => {
    // 模型额度直接影响对话本身，不能被 MCP 提示挡住。
    const state = buildSessionQuotaBannerState({
      activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      snapshot: entitlement({ dailyRemaining: 0, modelRemaining: 0 }),
      modelId: "glm-5.2",
      serverQuotaExhausted: true,
      mcpUnavailableNotice: {
        code: "quota_exceeded",
        rowId: 12,
        serverName: "zcode-official",
        toolName: "search_image",
      },
    });
    expect(state.kind).toBe("daily-exhausted");
    expect(state.priority).toBeGreaterThan(8);
  });

  it("MCP 提示的 dismiss key 跟随 server 与具体调用", () => {
    const build = (rowId: number, serverName: string) =>
      buildSessionQuotaBannerDismissKey(
        buildSessionQuotaBannerState({
          activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          snapshot: null,
          modelId: "glm-5.2",
          mcpUnavailableNotice: {
            code: "quota_exceeded",
            rowId,
            serverName,
            toolName: "search_image",
          },
        }),
      );
    // 关闭一次后同一次调用不再弹；新的失败调用或另一个 server 会重新弹。
    expect(build(12, "zcode-official")).toBe(build(12, "zcode-official"));
    expect(build(12, "zcode-official")).not.toBe(build(13, "zcode-official"));
    expect(build(12, "zcode-official")).not.toBe(build(12, "zcode-video-edit"));
  });

  it("从 rows 里取最新一条带标识的官方 MCP 调用", () => {
    const toolRow = (rowId: number, unavailable?: { code: "quota_exceeded" }): ConversationRow =>
      ({
        rowId,
        turnId: "t1",
        kind: "toolCall",
        toolCallId: `call-${rowId}`,
        toolName: "mcp__zcode-official__search_image",
        status: "success",
        inputText: "{}",
        display: {
          kind: "mcp_tool",
          serverName: "zcode-official",
          toolName: "search_image",
          ...(unavailable ? { unavailable } : {}),
        },
      }) as unknown as ConversationRow;

    expect(resolveMcpUnavailableNotice(undefined)).toBeNull();
    expect(resolveMcpUnavailableNotice([toolRow(1)])).toBeNull();
    expect(
      resolveMcpUnavailableNotice([
        toolRow(1, { code: "quota_exceeded" }),
        toolRow(2),
        toolRow(3, { code: "quota_exceeded" }),
      ]),
    ).toEqual({
      code: "quota_exceeded",
      rowId: 3,
      serverName: "zcode-official",
      toolName: "search_image",
    });
  });

  it("同一 MCP 工具的新成功调用覆盖旧失败，其他工具失败不受影响", () => {
    const toolRow = (
      rowId: number,
      serverName: string,
      toolName: string,
      unavailable?: { code: "quota_exceeded" },
    ): ConversationRow =>
      ({
        rowId,
        turnId: "t1",
        kind: "toolCall",
        toolCallId: `call-${rowId}`,
        toolName: `mcp__${serverName}__${toolName}`,
        status: "success",
        inputText: "{}",
        display: {
          kind: "mcp_tool",
          serverName,
          toolName,
          ...(unavailable ? { unavailable } : {}),
        },
      }) as unknown as ConversationRow;

    expect(
      resolveMcpUnavailableNotice([
        toolRow(1, "official", "search_image", { code: "quota_exceeded" }),
        toolRow(2, "official", "search_image"),
      ]),
    ).toBeNull();
    expect(
      resolveMcpUnavailableNotice([
        toolRow(1, "official", "search_image", { code: "quota_exceeded" }),
        toolRow(2, "official", "speech_synthesize"),
      ]),
    ).toMatchObject({ rowId: 1, toolName: "search_image" });
  });

  it("清洗 GLM bracket 文案并保留当前 Provider 身份", () => {
    expect(
      normalizeProviderLimitedBannerMessage("[1113][余额不足或无可用资源包,请充值。][request-id]"),
    ).toBe("余额不足或无可用资源包,请充值。");
    expect(
      resolveQuotaBannerUpgradeProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan);
  });
});
