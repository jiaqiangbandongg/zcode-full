// 草稿态工具条 workspace 缺省回落（m5-composer-parity §5.1）纯逻辑测试。
// Bug 背景（2026-07-07 v4 首测）：工具条门控在投影 config!==null 上，草稿态整体不渲染；
// 修复后草稿以 renderer intent 为显示真值，目录只在无 intent 时提供初始回落。
import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";
import {
  applyDraftModelSelection,
  buildDraftCreateConfigPayload,
  shouldHydrateWorkspaceCatalog,
} from "@/v4/composer/useDraftConfigControl.js";

describe("resolveDraftDisplayedConfig", () => {
  it("工具条只投影 Composer 的结构化选择", () => {
    expect(
      resolveDraftDisplayedConfig({
        modelSelection: { providerId: "glm", modelId: "GLM-5.2" },
      }),
    ).toEqual({
      modelSelection: { providerId: "glm", modelId: "GLM-5.2" },
      provider: "glm",
      model: "GLM-5.2",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    });
  });

  it("同模型的旧 Session 档位也不能补齐 Composer 留空的档位", () => {
    expect(
      resolveDraftDisplayedConfig({
        modelSelection: { providerId: "glm", modelId: "GLM-5.2" },
        thought: "medium",
      })?.thought,
    ).toBe("");
  });

  it("Composer 模型留空时不能恢复 Session 模型", () => {
    expect(
      resolveDraftDisplayedConfig({
        provider: "glm",
        model: "GLM-5-Turbo",
        mode: "yolo",
        modelSelection: undefined,
      }),
    ).toBeNull();
  });

  it("显示结构化选择的档位，不看平铺旧值", () => {
    expect(
      resolveDraftDisplayedConfig({
        thought: "medium",
        modelSelection: {
          providerId: "glm",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "low" },
        },
      })?.thought,
    ).toBe("low");
  });
});

describe("resolveDraftModelThoughtOption", () => {
  const modelSelectionView: ModelSelectionView = {
    revision: 1,
    providers: [
      {
        providerId: "glm",
        providerName: "GLM",
        config: {},
        models: [
          {
            modelId: "GLM-5.2",
            config: {
              optionSpecs: {
                reasoningLevel: {
                  values: ["low", "medium", "high"],
                  map: "{}",
                },
                maxOutputTokens: { max: 32_000, map: "{}" },
              },
            },
          },
          {
            modelId: "GLM-5-Turbo",
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: "{}" },
              },
            },
          },
          {
            modelId: "glm-5.2-pro",
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: "{}" },
              },
            },
          },
        ],
      },
    ],
  };

  it("returns the selected model's own levels without inventing a reasoning value", () => {
    expect(resolveDraftModelThoughtOption("glm", "GLM-5.2", modelSelectionView)).toMatchObject({
      currentValue: "",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    });
  });

  it("does not fall back to another model's thought capabilities", () => {
    expect(resolveDraftModelThoughtOption("glm", "unknown", modelSelectionView)).toBeNull();
  });

  it("does not infer reasoning from the GLM model name", () => {
    expect(resolveDraftModelThoughtOption("glm", "glm-5.2-pro", modelSelectionView)).toMatchObject({
      currentValue: "",
      options: [{ value: "disabled" }],
    });
  });

  it("uses the Registry model option spec", () => {
    const updatedSelectionView: ModelSelectionView = {
      revision: 2,
      providers: [
        {
          providerId: "glm",
          providerName: "GLM",
          config: {},
          models: [
            {
              modelId: "GLM-5.2",
              config: {
                optionSpecs: {
                  reasoningLevel: {
                    values: ["high", "max"],
                    map: "{}",
                  },
                  maxOutputTokens: { max: 32_000, map: "{}" },
                },
              },
            },
          ],
        },
      ],
    };

    expect(resolveDraftModelThoughtOption("glm", "GLM-5.2", updatedSelectionView)).toMatchObject({
      currentValue: "",
      options: [{ value: "high" }, { value: "max" }],
    });
  });
});

describe("resolveDraftThoughtCurrentValue", () => {
  it("模型目录的默认档位不能填补恢复选择的空档位", () => {
    const modelThoughtOption = resolveDraftModelThoughtOption(
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
      {
        revision: 1,
        providers: [
          {
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel Coding Plan",
            config: {},
            models: [
              {
                modelId: "GLM-5.3",
                config: {
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["high", "low", "max"],
                      map: "{}",
                    },
                    maxOutputTokens: { max: 32_000, map: "{}" },
                  },
                },
              },
            ],
          },
        ],
      },
    );

    expect(
      resolveDraftThoughtCurrentValue({
        thought: "",
        thoughtLevels: ["high", "low", "max"],
        // 目录自身仍可提供新选择的默认档位，但展示当前选择时不读取它。
      }),
    ).toBe("");
    expect(modelThoughtOption?.currentValue).toBe("");
  });

  it.each([
    ["high", "high"],
    ["removed", ""],
    [undefined, ""],
  ])("只展示有效的当前档位 %s", (thought, expected) => {
    expect(resolveDraftThoughtCurrentValue({ thought, thoughtLevels: ["low", "high"] })).toBe(
      expected,
    );
  });
});

describe("buildDraftCreateConfigPayload", () => {
  it("草稿跨模型选择会清除源模型 thought", () => {
    expect(
      applyDraftModelSelection(
        {
          provider: "glm",
          model: "GLM-5-Turbo",
          thought: "enabled",
          mode: "build",
        },
        { providerId: "glm", modelId: "GLM-5.2" },
      ),
    ).toEqual({
      provider: "glm",
      model: "GLM-5.2",
      modelSelection: { providerId: "glm", modelId: "GLM-5.2" },
      mode: "build",
    });
  });

  it("有草稿选择 → 携带 config 键；无选择 → 空对象（createSession 不带 config）", () => {
    expect(buildDraftCreateConfigPayload({ provider: "glm", model: "glm-4.7" })).toEqual({
      config: { provider: "glm", model: "glm-4.7" },
    });
    expect(buildDraftCreateConfigPayload({})).toEqual({});
  });

  it("app 交互行为偏好 → createSession.config.followupMode", () => {
    expect(buildDraftCreateConfigPayload({}, "guide")).toEqual({
      config: { followupMode: "guide" },
    });
    expect(buildDraftCreateConfigPayload({ provider: "glm", model: "glm-4.7" }, "queue")).toEqual({
      config: {
        provider: "glm",
        model: "glm-4.7",
        followupMode: "queue",
      },
    });
  });

  it("createSession 只使用当前 Composer 状态", () => {
    expect(
      buildDraftCreateConfigPayload({ model: "deepseek-v4-pro", thought: "low" }, "queue"),
    ).toEqual({
      config: {
        model: "deepseek-v4-pro",
        thought: "low",
        followupMode: "queue",
      },
    });
  });

  it("空 Composer 不制造 config", () => {
    expect(buildDraftCreateConfigPayload({}, null)).toEqual({});
  });
});

describe("shouldHydrateWorkspaceCatalog", () => {
  const modePresentation = [
    {
      id: "mode",
      name: "Mode",
      category: "mode" as const,
      type: "select" as const,
      currentValue: "build",
      options: [{ value: "build", name: "build" }],
    },
  ];
  const slashCatalog = [{ name: "review", description: "Review changes" }];

  it("模型目录已继承但 slash 目录被 task → draft 清空时仍需水合", () => {
    expect(
      shouldHydrateWorkspaceCatalog({
        configOptions: modePresentation,
        sessionId: null,
        slashCommands: [],
      }),
    ).toBe(true);
  });

  it("任一目录缺失时水合；两份目录均就绪时跳过", () => {
    expect(
      shouldHydrateWorkspaceCatalog({
        configOptions: [],
        sessionId: null,
        slashCommands: slashCatalog,
      }),
    ).toBe(true);
    expect(
      shouldHydrateWorkspaceCatalog({
        configOptions: modePresentation,
        sessionId: null,
        slashCommands: slashCatalog,
      }),
    ).toBe(false);
  });

  it("已有 session 仍独立水合 workspace slash 与非模型 mode 展示", () => {
    expect(
      shouldHydrateWorkspaceCatalog({
        configOptions: [],
        sessionId: "session-known",
        slashCommands: slashCatalog,
      }),
    ).toBe(true);
    expect(
      shouldHydrateWorkspaceCatalog({
        configOptions: modePresentation,
        sessionId: "session-known",
        slashCommands: [],
      }),
    ).toBe(true);
  });
});
