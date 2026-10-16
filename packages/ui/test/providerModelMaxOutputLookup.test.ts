// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsSection } from "@/settings/model-provider-section/ProviderCardSections.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import { MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS } from "@/settings/model-provider-section/useIdleTrigger.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

const providerSettingsServiceMock = vi.hoisted(() => ({
  resolveModelConfig: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    providerSettingsService: providerSettingsServiceMock,
  }),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          children,
          createElement(
            "button",
            {
              "aria-label": "模拟关闭弹窗",
              onClick: () => onOpenChange?.(false),
              type: "button",
            },
            "close",
          ),
        )
      : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("footer", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("header", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  DialogTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "common.cancel": "取消",
          "common.loading": "加载中...",
          "common.save": "保存",
          "settings.modelProvider.addModel": "添加模型",
          "settings.modelProvider.advanced": "高级",
          "settings.modelProvider.contextWindow": "上下文窗口",
          "settings.modelProvider.editModel": "编辑模型配置",
          "settings.modelProvider.editModelDescription": "编辑模型配置描述",
          "settings.modelProvider.maxOutputTokens": "最大输出 Token",
          "settings.modelProvider.modelId": "模型 ID",
          "settings.modelProvider.models": "模型列表",
          "settings.modelProvider.modelDefaultsLoaded":
            zhCN["settings.modelProvider.modelDefaultsLoaded"],
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

function createModelConfigResolution(maxOutputTokens = 32_000, contextWindow = 128_000) {
  const optionSpecs = {
    reasoningLevel: {
      values: ["disabled"],
      map: "{}",
    },
    maxOutputTokens: {
      max: maxOutputTokens,
      map: "{'max_tokens': maxOutputTokens}",
    },
  };
  return {
    inheritedConfig: {
      properties: {
        contextWindow,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs,
    },
    effectiveConfig: {
      properties: {
        contextWindow,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs,
    },
    issues: [],
  };
}

function renderAddModelSection(onAddModel = vi.fn(() => true)) {
  render(
    createElement(ProviderModelsSection, {
      providerId: "personal-provider",
      models: [],
      apiKeyValue: "",
      currentApiFormat: "openai-chat-completions",
      onModelCommit: vi.fn(),
      onDeleteModel: vi.fn(),
      onAddModel,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  const contextWindowInput = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
  if (!contextWindowInput) throw new Error("上下文窗口输入框未渲染");
  return {
    contextWindowInput,
    maxOutputTokensInput: screen.getByLabelText("最大输出 Token") as HTMLInputElement,
    modelIdInput: screen.getByPlaceholderText("模型 ID") as HTMLInputElement,
    onAddModel,
    saveButton: screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement,
  };
}

describe("provider model config resolution", () => {
  it("匹配提示使用智能配置文案，推理映射标签中英文语义一致", () => {
    expect(zhCN["settings.modelProvider.modelDefaultsLoaded"]).toBe("已匹配到智能配置");
    expect(zhCN["settings.modelProvider.reasoningLevelMapping"]).toBe("推理参数映射");
    expect(enUS["settings.modelProvider.reasoningLevelMapping"]).toBe(
      "Reasoning parameter mapping",
    );
    expect(zhCN["settings.modelProvider.modelMetadata.invalid.reasoningLevelMap"]).toBe(
      "推理参数映射无效",
    );
    expect(enUS["settings.modelProvider.modelDefaultsLoaded"]).toBe(
      "Smart configuration matched for this model",
    );
  });
  beforeEach(() => {
    vi.useFakeTimers();
    providerSettingsServiceMock.resolveModelConfig.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("最大输出字段位于 Token 分组，Reasoning 配置直接展示", () => {
    render(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          idValue: "custom-model",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "8192",
          reasoningLevelValuesValue: [],
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const maxOutputTokensInput = screen.getByLabelText("最大输出 Token");
    expect(maxOutputTokensInput.tagName).toBe("INPUT");
    expect(screen.getByLabelText("上下文窗口").tagName).toBe("INPUT");
    for (const help of document.querySelectorAll("[data-model-help]")) {
      expect(help.closest("label")).toBeNull();
    }
    expect(
      maxOutputTokensInput
        .closest("[data-model-settings-group]")
        ?.getAttribute("data-model-settings-group"),
    ).toBe("tokens");
    expect(screen.queryByRole("button", { name: "高级" })).toBeNull();
    expect(document.querySelector('[data-model-reasoning-level-editor="true"]')).toBeTruthy();
    expect(maxOutputTokensInput).toBeTruthy();
  });

  it("添加模型时等待统一 idle 时间解析并允许覆盖 Config Rule 回填值", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(64_000),
    );
    const onAddModel = vi.fn();
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    expect(maxOutputTokensInput.disabled).toBe(true);
    fireEvent.change(modelIdInput, { target: { value: "g" } });
    fireEvent.change(modelIdInput, { target: { value: "glm" } });
    fireEvent.change(modelIdInput, { target: { value: "glm-5" } });

    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(onAddModel).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS - 1);
    });
    expect(providerSettingsServiceMock.resolveModelConfig).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledTimes(1);
    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledWith({
      providerId: "personal-provider",
      modelId: "glm-5",
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("64000");
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);

    fireEvent.change(maxOutputTokensInput, { target: { value: "96000" } });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(onAddModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "glm-5",
        config: expect.objectContaining({
          properties: expect.objectContaining({ contextWindow: 128_000 }),
          optionSpecs: expect.objectContaining({
            maxOutputTokens: expect.objectContaining({ max: 96_000 }),
          }),
        }),
      }),
    );
    expect(onAddModel.mock.calls[0]?.[0].personalConfig).toEqual({
      optionSpecs: {
        maxOutputTokens: { max: 96_000 },
      },
    });
  });

  it("显式保存会立即解析当前模型并在同一次点击中提交", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(128_000, 1_000_000),
    );
    const onAddModel = vi.fn();
    const { modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "GLM-5.3-Flash" } });
    await act(async () => {
      fireEvent.click(saveButton);
      await Promise.resolve();
    });

    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledTimes(1);
    expect(onAddModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "GLM-5.3-Flash",
        config: expect.objectContaining({
          properties: expect.objectContaining({ contextWindow: 1_000_000 }),
        }),
      }),
    );
  });

  it("迟到的默认配置不会覆盖用户已经修改的布尔字段", async () => {
    let finishResolution:
      | ((resolution: ReturnType<typeof createModelConfigResolution>) => void)
      | undefined;
    providerSettingsServiceMock.resolveModelConfig.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve;
      }),
    );
    const onAddModel = vi.fn();
    const { modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "delayed-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-model-advanced-trigger]")!);
    const webSearch = screen.getByRole("checkbox", {
      name: "settings.modelProvider.supportsNativeWebSearch",
    });
    fireEvent.click(webSearch);
    expect(webSearch.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      finishResolution?.(createModelConfigResolution(64_000));
      await Promise.resolve();
    });
    expect(webSearch.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(onAddModel.mock.calls[0]?.[0].personalConfig).toMatchObject({
      properties: { supportsNativeWebSearch: true },
    });
  });

  it("允许清空 Config Rule 回填值并以 undefined 提交", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(64_000),
    );
    const onAddModel = vi.fn();
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "glm-5" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("64000");

    fireEvent.change(maxOutputTokensInput, { target: { value: "" } });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(onAddModel).toHaveBeenCalledTimes(1);
    expect(onAddModel.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        modelId: "glm-5",
        config: expect.objectContaining({
          optionSpecs: {
            maxOutputTokens: {
              max: 64_000,
              map: "{'max_tokens': maxOutputTokens}",
            },
            reasoningLevel: { values: ["disabled"], map: "{}" },
          },
        }),
      }),
    );
  });

  it("Config Rule 未声明最大输出时保持空白并恢复手动输入", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(createModelConfigResolution());
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection();

    fireEvent.change(modelIdInput, {
      target: { value: "unknown-output" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });

    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
  });

  it("Config Rule 解析失败时保持空白并恢复手动输入", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockRejectedValue(
      new Error("config resolution unavailable"),
    );
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection();

    fireEvent.change(modelIdInput, {
      target: { value: "config-error-model" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });

    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
  });

  it("模型 ID 变化时清除上一模型的 Config Resolution 值", async () => {
    providerSettingsServiceMock.resolveModelConfig
      .mockResolvedValueOnce(createModelConfigResolution(64_000, 256_000))
      .mockResolvedValueOnce(createModelConfigResolution(16_000, 64_000));
    const { contextWindowInput, modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(contextWindowInput.value).toBe("");
    expect(contextWindowInput.placeholder).toBe("256000");

    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    expect(contextWindowInput.value).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(contextWindowInput.value).toBe("");
    expect(contextWindowInput.placeholder).toBe("64000");
  });

  it("忽略模型 ID 变化前尚未完成的 Config Rule 解析结果", async () => {
    let resolveFirstLookup:
      | ((resolution: ReturnType<typeof createModelConfigResolution>) => void)
      | undefined;
    const firstLookup = new Promise<ReturnType<typeof createModelConfigResolution>>((resolve) => {
      resolveFirstLookup = resolve;
    });
    providerSettingsServiceMock.resolveModelConfig
      .mockReturnValueOnce(firstLookup)
      .mockResolvedValueOnce(createModelConfigResolution(16_000));
    const { maxOutputTokensInput, modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    expect(maxOutputTokensInput.value).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("16000");

    await act(async () => {
      resolveFirstLookup?.(createModelConfigResolution(64_000));
      await firstLookup;
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("16000");
  });

  it("编辑模型只展示和修改已有值，不触发 catalog 查询", () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn(() => true);
    render(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          idValue: "custom-model",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "8192",
          reasoningLevelValuesValue: [],
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange,
        onCommit,
      }),
    );

    const maxOutputTokensInput = screen.getByLabelText("最大输出 Token") as HTMLInputElement;

    expect(screen.queryByRole("button", { name: "高级" })).toBeNull();
    // Todo141：最大输出在基础区，高级仍默认收起；查看/编辑/展开都不应触发 catalog 查询。
    const advanced = document.querySelector<HTMLElement>("[data-model-advanced]")!;
    const trigger = advanced.querySelector<HTMLButtonElement>("[data-model-advanced-trigger]")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(advanced.contains(maxOutputTokensInput)).toBe(false);
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(maxOutputTokensInput.value).toBe("8192");
    fireEvent.change(maxOutputTokensInput, { target: { value: "16384" } });
    expect(onDraftChange).toHaveBeenCalledWith({
      maxOutputTokensValue: "16384",
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(providerSettingsServiceMock.resolveModelConfig).not.toHaveBeenCalled();
  });

  it("展示 reasoning 默认配置并且相同解析结果不重复显示成功横幅", async () => {
    const resolution = createModelConfigResolution(128_000, 1_000_000);
    resolution.inheritedConfig.optionSpecs = {
      ...resolution.inheritedConfig.optionSpecs,
      reasoningLevel: {
        values: ["low", "high", "max"],
        map: "{'reasoning_effort': reasoningLevel}",
      },
    };
    resolution.effectiveConfig.optionSpecs = resolution.inheritedConfig.optionSpecs;
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(resolution);
    const { modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "GLM-5.3-Flash" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });

    const editor = document.querySelector('[data-model-reasoning-level-editor="true"]');
    expect(editor).toBeTruthy();
    expect(editor?.textContent).toContain("low");
    expect(editor?.textContent).toContain("high");
    expect(editor?.textContent).toContain("max");
    expect(document.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
    expect(screen.getAllByText("已匹配到智能配置")).toHaveLength(1);

    fireEvent.blur(modelIdInput);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_501);
    });
    expect(screen.queryByText("已匹配到智能配置")).toBeNull();
  });
});
