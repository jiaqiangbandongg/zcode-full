import type { ModelSelectionView } from "@zcode/provider";
import { describe, expect, it } from "vitest";
import { resolveOffPeakClientConfig } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";

const env = {} as NodeJS.ProcessEnv;
const modelSelectionView = {
  revision: 7,
  providers: [
    {
      providerId: "account:zai-offpeak-idle-plan",
      config: { visibility: "hidden" },
      models: [
        { modelId: "GLM-5.2", config: {} },
        { modelId: "GLM-5-Turbo", config: {} },
      ],
    },
  ],
} as unknown as ModelSelectionView;

function envelope(enableOffPeakTask: boolean, extra: Record<string, unknown> = {}) {
  return {
    data: {
      configs: {
        offPeak: { enable_offpeak_task: enableOffPeakTask, ...extra },
      },
    },
  } as never;
}

describe("resolveOffPeakClientConfig", () => {
  it("远端字段只控制曝光，模型视图原样来自 Registry", () => {
    expect(resolveOffPeakClientConfig(envelope(true), env, modelSelectionView)).toEqual({
      enabled: true,
      modelSelectionView,
    });
    expect(resolveOffPeakClientConfig(envelope(false), env, modelSelectionView).enabled).toBe(
      false,
    );
  });

  it("Registry 视图没有模型时保持关闭", () => {
    const empty = { revision: 8, providers: [] } satisfies ModelSelectionView;
    expect(resolveOffPeakClientConfig(envelope(true), env, empty)).toEqual({
      enabled: false,
      modelSelectionView: empty,
    });
  });

  it("忽略远端 legacy allowed_models 与 builtinModels 模型事实", () => {
    const payload = {
      data: {
        builtinModels: [{ modelId: "REMOTE-MODEL", contextWindow: 42 }],
        configs: {
          offPeak: {
            enable_offpeak_task: true,
            allowed_models: ["REMOTE-MODEL"],
          },
        },
      },
    } as never;

    expect(resolveOffPeakClientConfig(payload, env, modelSelectionView).modelSelectionView).toBe(
      modelSelectionView,
    );
  });

  it("mock 只替代曝光和套餐状态，模型候选仍是同一个 Registry 视图", () => {
    expect(
      resolveOffPeakClientConfig(
        {} as never,
        { ZCODE_OFFPEAK_MOCK: "1" } as NodeJS.ProcessEnv,
        modelSelectionView,
      ),
    ).toEqual({ enabled: true, modelSelectionView, codingPlanActive: true });
  });

  it("mock no-plan 只改变展示权益", () => {
    expect(
      resolveOffPeakClientConfig(
        {} as never,
        { ZCODE_OFFPEAK_MOCK: "1", ZCODE_OFFPEAK_MOCK_NO_PLAN: "1" } as NodeJS.ProcessEnv,
        modelSelectionView,
      ).codingPlanActive,
    ).toBe(false);
  });
});
