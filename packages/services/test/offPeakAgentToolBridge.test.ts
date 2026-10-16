import { describe, expect, it } from "vitest";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
  OFF_PEAK_MUTATION_TOOL_NAMES,
} from "../src/zcode-agent/automationToolPolicy.js";
import {
  resolveOffPeakAllowedModels,
  resolveOffPeakCreateModel,
  resolveOffPeakToolSelection,
  toProtocolOffPeakTaskSnapshot,
} from "../src/zcode-agent/zcodeAgentService.js";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

describe("off-peak tool policy（D49）", () => {
  it("OffPeakCreate 绝不混入 AUTOMATION_MUTATION_TOOL_NAMES（cron 轮放行是产品定案 D49-3）", () => {
    // 最大照抄陷阱回归锁：任何一份 automation 常量副本混入 OffPeakCreate 都会让
    // cron automation 执行轮误 deny 组合玩法。
    expect(AUTOMATION_MUTATION_TOOL_NAMES).not.toContain("OffPeakCreate");
    expect(OFF_PEAK_MUTATION_TOOL_NAMES).toEqual(["OffPeakCreate"]);
    expect(mergeAutomationMutationToolDenylist(undefined)).not.toContain("OffPeakCreate");
  });

  it("mergeOffPeakMutationToolDenylist 只追加 OffPeakCreate 且不覆盖既有策略", () => {
    expect(mergeOffPeakMutationToolDenylist(["CronCreate"])).toEqual([
      "CronCreate",
      "OffPeakCreate",
    ]);
    expect(mergeOffPeakMutationToolDenylist(["OffPeakCreate"])).toEqual(["OffPeakCreate"]);
  });
});

describe("Off-Peak 工具按当前 Selection View 创建", () => {
  const config = { enabled: true, modelSelectionView: offPeakSelectionView() };
  const providerId = OFF_PEAK_PROVIDER_IDS.zai;

  it("曝光关闭或没有候选时不开放；精确指定 Provider 时不混用另一账号域", () => {
    expect(resolveOffPeakAllowedModels(undefined)).toEqual([]);
    expect(resolveOffPeakAllowedModels({ ...config, enabled: false })).toEqual([]);
    expect(
      resolveOffPeakAllowedModels({
        enabled: true,
        modelSelectionView: { revision: 2, providers: [] },
      }),
    ).toEqual([]);
    expect(resolveOffPeakAllowedModels(config, providerId)).toEqual(["ZAI-only", "GLM-5.2"]);
    expect(resolveOffPeakAllowedModels(config, "missing")).toEqual([]);
  });

  it("省略 model 取末位；显式 trim/大小写匹配后保留原 ID，未命中不 fallback", () => {
    const allowed = ["GLM-5.1", "GLM-5.2"];
    expect(resolveOffPeakCreateModel(allowed, undefined)).toBe("GLM-5.2");
    expect(resolveOffPeakCreateModel(allowed, "  ")).toBe("GLM-5.2");
    expect(resolveOffPeakCreateModel(allowed, " glm-5.1 ")).toBe("GLM-5.1");
    expect(resolveOffPeakCreateModel(allowed, "GLM-4")).toBeNull();
    expect(resolveOffPeakCreateModel([], undefined)).toBeNull();
  });

  it("新建使用公共最高档规则，结构化选择不读取旧 reasoning metadata", () => {
    expect(resolveOffPeakToolSelection(config.modelSelectionView, providerId, "GLM-5.2")).toEqual({
      providerId,
      modelId: "GLM-5.2",
      options: { reasoningLevel: "max" },
    });
    expect(
      resolveOffPeakToolSelection(offPeakSelectionView(["alpha", "beta"]), providerId, "GLM-5.2")
        ?.options?.reasoningLevel,
    ).toBe("beta");
    // values 是语义顺序的唯一权威，不能另写按名字 max/high 排序的第二套规则。
    expect(
      resolveOffPeakToolSelection(
        offPeakSelectionView(["max", "custom-strongest"]),
        providerId,
        "GLM-5.2",
      )?.options?.reasoningLevel,
    ).toBe("custom-strongest");
  });

  it("显式档位保留给创建服务校验，不覆盖为最高档；其他域和缺失配置不猜默认", () => {
    expect(
      resolveOffPeakToolSelection(config.modelSelectionView, providerId, "GLM-5.2", "high")?.options
        ?.reasoningLevel,
    ).toBe("high");
    expect(
      resolveOffPeakToolSelection(config.modelSelectionView, providerId, "BigModel-only"),
    ).toBeUndefined();
    expect(
      resolveOffPeakToolSelection(config.modelSelectionView, providerId, "glm-unknown"),
    ).toBeUndefined();
    expect(
      resolveOffPeakToolSelection(offPeakSelectionView([]), providerId, "GLM-5.2"),
    ).toBeUndefined();
  });
});

describe("toProtocolOffPeakTaskSnapshot（协议最小面）", () => {
  it("只暴露卡片/列表所需字段，位次非正数与空 sessionId 不下发", () => {
    expect(
      toProtocolOffPeakTaskSnapshot({
        offPeakTaskId: "offpeak-1",
        title: "t",
        status: "queued",
        queuePosition: 0,
        createdAt: 1_700_000_000_000,
      }),
    ).toEqual({
      offPeakTaskId: "offpeak-1",
      title: "t",
      status: "queued",
      createdAt: 1_700_000_000_000,
    });
    expect(
      toProtocolOffPeakTaskSnapshot({
        offPeakTaskId: "offpeak-2",
        title: "t2",
        status: "running",
        queuePosition: 2,
        sessionId: "sess-1",
        createdAt: 1,
      }),
    ).toEqual({
      offPeakTaskId: "offpeak-2",
      title: "t2",
      status: "running",
      queuePosition: 2,
      sessionId: "sess-1",
      createdAt: 1,
    });
  });
});
