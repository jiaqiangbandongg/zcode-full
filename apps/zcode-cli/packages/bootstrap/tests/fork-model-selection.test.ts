// 会话派生（分叉 / 编辑前分叉）的常驻 Selection 推导回归。
// Bug：加速中的会话分叉后没有把原模型带过去——分叉点消息记录的是加速卡的单轮执行
// Selection（highspeed-card-spec §5），旧实现把它当成会话选型继承给 child。
import { describe, expect, it } from "vitest";
import { HIGHSPEED_PROVIDER_IDS } from "@zcode/shared";
import {
  cloneModelSelection,
  derivedSessionModelSelection,
  modelSelectionWithOptionFallback,
} from "../src/zcode-protocol/fork-model-selection.js";

const sessionSelection = {
  providerId: "builtin:zai-coding-plan",
  modelId: "glm-4.6",
  options: { reasoningLevel: "high" },
};

describe("派生会话的常驻 Selection", () => {
  it("分叉点是加速轮时退回父会话常驻 Selection，不继承加速 Provider", () => {
    for (const providerId of Object.values(HIGHSPEED_PROVIDER_IDS)) {
      const derived = derivedSessionModelSelection(
        { providerId, modelId: "glm-5", options: { reasoningLevel: "max" } },
        sessionSelection,
      );

      // 加速期间会话常驻 Selection 从未被改写，它就是用户的原模型。
      expect(derived).toEqual(sessionSelection);
      expect(derived).not.toBe(sessionSelection);
    }
  });

  it("父会话也没有常驻 Selection 时宁可留空，也不把加速 Provider 写进 child", () => {
    expect(
      derivedSessionModelSelection(
        { providerId: HIGHSPEED_PROVIDER_IDS.zai, modelId: "glm-5" },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("普通分叉点继承消息选型，缺失推理档位时回落会话档位", () => {
    expect(
      derivedSessionModelSelection(
        { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "low" } },
        sessionSelection,
      ),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "low" },
    });
    expect(
      derivedSessionModelSelection(
        { providerId: "provider-a", modelId: "model-a" },
        sessionSelection,
      ),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });

  it("分叉点消息没有选型事实时按会话常驻 Selection 派生", () => {
    expect(derivedSessionModelSelection(undefined, sessionSelection)).toEqual(sessionSelection);
    expect(derivedSessionModelSelection(undefined, undefined)).toBeUndefined();
  });
});

describe("Selection 复制原语", () => {
  it("cloneModelSelection 不与源共享 options 引用", () => {
    const cloned = cloneModelSelection(sessionSelection);
    expect(cloned).toEqual(sessionSelection);
    expect(cloned?.options).not.toBe(sessionSelection.options);
    expect(cloneModelSelection(undefined)).toBeUndefined();
  });

  it("modelSelectionWithOptionFallback 只回落推理档位，不回落模型身份", () => {
    expect(
      modelSelectionWithOptionFallback({ providerId: "p", modelId: "m" }, sessionSelection),
    ).toEqual({ providerId: "p", modelId: "m", options: { reasoningLevel: "high" } });
    expect(modelSelectionWithOptionFallback({ providerId: "p", modelId: "m" }, undefined)).toEqual({
      providerId: "p",
      modelId: "m",
    });
  });
});
