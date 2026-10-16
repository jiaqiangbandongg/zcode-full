import type { ZCodeConfigOption } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  mergeRecoveredTaskModelConfigOptions,
  mergeGlmRecoveredTaskModelConfigOptions,
  resolveTaskRestorePreloadConfigOptions,
  resolveRecoveredTaskModelValue,
  resolveGlmRecoveredTaskModelValue,
} from "@/lib/taskModelRecovery.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

describe("task model recovery", () => {
  it("会把 task.meta.model 里的 provider/model 还原成工具栏 custom 模型值", () => {
    expect(resolveGlmRecoveredTaskModelValue("zai-api/glm-5.1")).toBe(
      encodeCustomModelValue("zai-api", "glm-5.1"),
    );
  });

  it("非 GLM task 使用 task meta 模型作为恢复期工具栏回显来源", () => {
    expect(
      resolveRecoveredTaskModelValue({
        provider: "codex",
        model: "gpt-5.4",
      }),
    ).toBe("gpt-5.4");
  });

  it("非 GLM 恢复态没有 configOptions 时，也会用 task meta 合成最小模型配置", () => {
    const recovered = mergeRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "codex",
        model: "gpt-5.4",
      },
      configOptions: [],
    });

    expect(recovered).toEqual([
      {
        category: "model",
        currentValue: "gpt-5.4",
        id: "model",
        name: "Model",
        options: [
          {
            name: "gpt-5.4",
            value: "gpt-5.4",
          },
        ],
        type: "select",
      },
    ]);
  });

  it("非 GLM custom task meta 会用模型名作为合成选项名称", () => {
    const modelValue = encodeCustomModelValue("provider-demo", "qwen-plus");
    const recovered = mergeRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "codex",
        model: modelValue,
      },
      configOptions: [],
    });

    expect(recovered?.[0]).toEqual({
      category: "model",
      currentValue: modelValue,
      id: "model",
      name: "Model",
      options: [
        {
          name: "qwen-plus",
          value: modelValue,
        },
      ],
      type: "select",
    });
  });

  it("非 GLM provider/model 历史值只把模型名用于工具栏展示", () => {
    const recovered = mergeRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "codex",
        model: "36965ea6-734a-46a8-8851-3dfec026589e/glm-5.1-highspeed",
      },
      configOptions: [],
    });

    expect(recovered?.[0]).toEqual({
      category: "model",
      currentValue: "36965ea6-734a-46a8-8851-3dfec026589e/glm-5.1-highspeed",
      id: "model",
      name: "Model",
      options: [
        {
          name: "glm-5.1-highspeed",
          value: "36965ea6-734a-46a8-8851-3dfec026589e/glm-5.1-highspeed",
        },
      ],
      type: "select",
    });
  });

  it("GLM 恢复态没有 configOptions 时，会用 task meta 合成最小模型配置", () => {
    const recovered = mergeGlmRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "glm",
        model: "provider-demo/qwen-plus",
      },
      configOptions: [],
    });

    expect(recovered).toEqual([
      {
        category: "model",
        currentValue: encodeCustomModelValue("provider-demo", "qwen-plus"),
        id: "model",
        name: "Model",
        options: [
          {
            name: "qwen-plus",
            value: encodeCustomModelValue("provider-demo", "qwen-plus"),
          },
        ],
        type: "select",
      },
    ]);
  });

  it("已有模型配置时，只补回 GLM task meta 的当前模型值", () => {
    const currentConfigOptions: ZCodeConfigOption[] = [
      {
        category: "model",
        currentValue: "",
        id: "model",
        name: "Model",
        options: [{ name: "old-model", value: "old-model" }],
        type: "select",
      },
      {
        category: "mode",
        currentValue: "plan",
        id: "mode",
        name: "Mode",
        options: [{ name: "Plan", value: "plan" }],
        type: "select",
      },
    ];

    const recovered = mergeGlmRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "glm",
        model: "provider-demo/qwen-plus",
      },
      configOptions: currentConfigOptions,
    });

    expect(recovered?.[0]).toEqual({
      category: "model",
      currentValue: encodeCustomModelValue("provider-demo", "qwen-plus"),
      id: "model",
      name: "Model",
      options: [
        { name: "old-model", value: "old-model" },
        {
          name: "qwen-plus",
          value: encodeCustomModelValue("provider-demo", "qwen-plus"),
        },
      ],
      type: "select",
    });
    expect(recovered?.[1]).toBe(currentConfigOptions[1]);
  });

  it("已有模型配置已经匹配 task meta 时，不再生成新的恢复配置", () => {
    const currentModel = encodeCustomModelValue("provider-demo", "qwen-plus");
    const currentConfigOptions: ZCodeConfigOption[] = [
      {
        category: "model",
        currentValue: currentModel,
        id: "model",
        name: "Model",
        options: [{ name: "qwen-plus", value: currentModel }],
        type: "select",
      },
    ];

    const recovered = mergeGlmRecoveredTaskModelConfigOptions({
      taskMeta: {
        provider: "glm",
        model: "provider-demo/qwen-plus",
      },
      configOptions: currentConfigOptions,
    });

    expect(recovered).toBeNull();
  });

  it("历史 task 恢复期会优先保留 task 级 mode 和 thought_level 缓存", () => {
    const currentConfigOptions: ZCodeConfigOption[] = [
      {
        category: "model",
        currentValue: "old-model",
        id: "model",
        name: "Model",
        options: [{ name: "old-model", value: "old-model" }],
        type: "select",
      },
      {
        category: "mode",
        currentValue: "yolo",
        id: "mode",
        name: "Mode",
        options: [{ name: "YOLO", value: "yolo" }],
        type: "select",
      },
      {
        category: "thought_level",
        currentValue: "max",
        id: "thought_level",
        name: "Thought",
        options: [{ name: "Max", value: "max" }],
        type: "select",
      },
    ];

    const recovered = resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: "glm",
        model: "provider-demo/qwen-plus",
      },
      cachedTaskConfigOptions: currentConfigOptions,
    });

    expect(recovered.map((option) => option.category)).toEqual(["model", "mode", "thought_level"]);
    expect(recovered[0]?.currentValue).toBe(encodeCustomModelValue("provider-demo", "qwen-plus"));
    expect(recovered[1]).toBe(currentConfigOptions[1]);
    expect(recovered[2]).toBe(currentConfigOptions[2]);
  });

  it("历史 task meta 暂缺模型时不会清空已有 task 配置缓存", () => {
    const currentConfigOptions: ZCodeConfigOption[] = [
      {
        category: "mode",
        currentValue: "yolo",
        id: "mode",
        name: "Mode",
        options: [{ name: "YOLO", value: "yolo" }],
        type: "select",
      },
    ];

    const recovered = resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: "glm",
        model: undefined,
      },
      cachedTaskConfigOptions: currentConfigOptions,
    });

    expect(recovered).toEqual(currentConfigOptions);
    expect(recovered).not.toBe(currentConfigOptions);
  });

  it("非 GLM task 不使用该兜底来源", () => {
    expect(
      mergeGlmRecoveredTaskModelConfigOptions({
        taskMeta: {
          provider: "codex",
          model: "provider-demo/gpt-5.4",
        },
        configOptions: [],
      }),
    ).toBeNull();
  });

  it("synthetic 模型占位不会被合成成历史恢复模型", () => {
    expect(
      mergeRecoveredTaskModelConfigOptions({
        taskMeta: {
          provider: "claude",
          model: "<synthetic>",
        },
        configOptions: [],
      }),
    ).toBeNull();
  });
});
