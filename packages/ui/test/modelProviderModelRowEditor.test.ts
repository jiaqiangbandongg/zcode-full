// @vitest-environment jsdom
import { createElement } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPortal } from "react-dom";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  testId,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InlineEditableProviderCard,
  PROVIDER_TEXT_INPUT_IDLE_SAVE_MS,
  shouldApplyProviderSaveCompletion,
} from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import {
  formatModelContextWindowLabel,
  ProviderModelsSection,
  resolveProviderApiFormatOptions,
} from "@/settings/model-provider-section/ProviderCardSections.js";
import { ModelRowInput } from "@/settings/model-provider-section/ProviderFormControls.js";
import { confirmAndDeleteModelProvider } from "@/settings/model-provider-section/modelProviderActions.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import {
  isInteractiveModelDragTarget,
  resolveReorderedModelIds,
  resolveSortableProviderModelRowClassName,
  SortableProviderModelList,
} from "@/settings/model-provider-section/SortableProviderModelList.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const messages: Record<string, string> = {
          "settings.modelProvider.addModel": "添加模型",
          "model.capability.vision": "视觉",
          "settings.modelProvider.contextWindow": "上下文窗口",
          "settings.modelProvider.contextWindowBadgeLabel": "上下文窗口：{value}",
          "settings.modelProvider.delete": "删除",
          "settings.modelProvider.disableAction": "停用",
          "settings.modelProvider.enableAction": "启用",
          "settings.modelProvider.restoreDefaultAction": "恢复默认",
          "settings.modelProvider.followRecommendedConfig": "跟随推荐配置",
          "settings.modelProvider.editModel": "编辑模型配置",
          "settings.modelProvider.apiFormat": "API 格式",
          "settings.modelProvider.apiFormat.anthropicMessages": "Anthropic Messages (/v1/messages)",
          "settings.modelProvider.apiFormat.chatCompletions":
            "Chat Completions (/chat/completions)",
          "settings.modelProvider.apiFormat.responses": "Responses (/responses)",
          "settings.modelProvider.apiFormat.short.anthropicMessages": "Anthropic",
          "settings.modelProvider.apiFormat.short.chatCompletions": "Chat",
          "settings.modelProvider.apiFormat.short.responses": "Responses",
          "settings.modelProvider.apiFormat.title.anthropicMessages": "Anthropic Messages",
          "settings.modelProvider.baseUrl": "Base URL",
          "settings.modelProvider.baseUrlPlaceholder": "https://api.example.com",
          "settings.modelProvider.readOnlyField": "{field}（只读）",
          "settings.modelProvider.maxOutputTokens": "最大输出 Token",
          "settings.modelProvider.inputModalities": "输入类型",
          "settings.modelProvider.outputModalities": "输出类型",
          "settings.modelProvider.modelDisplayName": "显示名称",
          "settings.modelProvider.modelId": "模型 ID",
          "settings.modelProvider.modelApiFormat.anthropic": "Anthropic Messages",
          "settings.modelProvider.modelApiFormat.openaiCompatible": "OpenAI Compatible",
          "settings.modelProvider.modelApiFormat.openaiResponses": "OpenAI Responses",
          "settings.modelProvider.models": "模型列表",
          "settings.modelProvider.modelsEmpty": "当前没有配置模型，添加模型后可在聊天中使用。",
          "settings.modelProvider.testModel": "测试模型",
          "settings.modelProvider.testModel.connectingWithIdentity":
            "{provider} / {model} 正在连接",
          "settings.modelProvider.testModel.successWithIdentity": "{provider} / {model} 连接成功",
          "settings.modelProvider.testModel.failedWithIdentity":
            "{provider} / {model} 连接失败：{reason}",
          "settings.modelProvider.providerSaving": "{provider} 正在保存",
          "settings.modelProvider.providerSaveSuccess": "{provider} 保存成功",
          "settings.modelProvider.providerSaveFailure": "{provider} 保存失败：{error}",
          "settings.modelProvider.modelSaving": "{provider} / {model} 正在保存",
          "settings.modelProvider.modelSaveSuccess": "{provider} / {model} 保存成功",
          "settings.modelProvider.modelSaveFailure": "{provider} / {model} 保存失败：{error}",
          "common.retry": "重试",
          "common.close": "关闭",
          "common.save": "保存",
          "common.cancel": "取消",
        };
        return (messages[id] ?? id).replace(
          /\{(\w+)\}/g,
          (_match, key: string) => values?.[key] ?? `{${key}}`,
        );
      },
    },
  }),
}));

const settingsService = vi.hoisted(() => ({ resolveModelConfig: vi.fn() }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: settingsService }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    openExternal: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderWithProviderFeedback(element: React.ReactNode) {
  return render(createElement(ProviderDetailFeedbackBoundary, null, element));
}

function createModelProviderModelConfig(input: {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsJsonSchemaOutput?: boolean;
}): ProviderSettingsFormProvider["models"][number] {
  const maxOutputTokens = input.maxOutputTokens ?? 32_000;
  const config = {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: input.contextWindow ?? 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: input.supportsTools ?? true,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput ?? true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: maxOutputTokens,
        map: "{'max_tokens': maxOutputTokens}",
      },
    },
  };
  return {
    kind: "candidate",
    modelId: input.id,
    builtin: false,
    personalConfig: structuredClone(config),
    hasPersonalConfig: true,
    executable: true,
    selectable: true,
    config,
  };
}

function createProvider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "provider-deepseek",
    providerName: "DeepSeek",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    personalConfig: {
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com" },
      personalModelIds: ["deepseek-v4-flash"],
      enabled: true,
    },
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com" },
      personalModelIds: ["deepseek-v4-flash"],
      enabled: true,
    },
    models: [
      createModelProviderModelConfig({
        id: "deepseek-v4-flash",
        kinds: ["anthropic", "openai-compatible"],
      }),
    ],
    ...overrides,
  };
}

describe("ProviderModelsSection compact model rows", () => {
  it.each(["individual-coding-plan", "team-coding-plan", "start-plan", "manual", "standard"])(
    "设置页共享视觉标判断，连接=%s",
    (mode) => {
      const provider = createProvider();
      provider.config.access =
        mode === "manual"
          ? { type: "zhipu-coding-plan-api-key", apiKey: "fixture" }
          : mode === "standard"
            ? { type: "api-key", apiKey: "fixture" }
            : {
                type: "zhipu-account",
                accountType: "bigmodel",
                mode: mode as "individual-coding-plan" | "team-coding-plan" | "start-plan",
              };
      provider.models = ["GLM-5.3", "GLM-5.3-Flash"].map((id) => {
        const model = createModelProviderModelConfig({ id });
        model.config.properties!.inputFormat = {
          ...model.config.properties?.inputFormat,
          supportsImage: true,
        };
        return model;
      });
      render(createElement(InlineEditableProviderCard, { provider, onSave: vi.fn() }));
      expect(screen.getAllByText("视觉")).toHaveLength(mode === "standard" ? 2 : 1);
      expect(provider.models[0]!.config.properties?.inputFormat?.supportsImage).toBe(true);
    },
  );
  it("切换 Provider 时相同模型 ID 也不能复用上一个 Provider 的编辑事务", async () => {
    const initial = createProvider();
    const view = render(
      createElement(InlineEditableProviderCard, { provider: initial, onSave: vi.fn() }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
    fireEvent.change(document.querySelector('input[inputmode="numeric"]')!, {
      target: { value: "123456" },
    });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: { ...initial, providerId: "other-provider" },
        onSave: vi.fn(),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
    expect(
      (document.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value,
    ).not.toBe("123456");
  });
  it("Todo138：新增空 ID 无档位，解析后显示推荐，清空 ID 恢复空草稿", async () => {
    const config = createModelProviderModelConfig({ id: "new-model" }).config;
    settingsService.resolveModelConfig.mockResolvedValue({
      inheritedConfig: config,
      effectiveConfig: config,
      issues: [],
      revision: 1,
    });
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [] }),
        onSave: vi.fn(),
        onAddPersonalModel: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON));
    const chips = () => document.querySelectorAll("[data-model-reasoning-chip]");
    expect(chips()).toHaveLength(0);
    expect(settingsService.resolveModelConfig).not.toHaveBeenCalled();
    const id = document.querySelector("[data-model-identity-row] input")!;
    fireEvent.change(id, { target: { value: "new-model" } });
    fireEvent.blur(id);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]?.textContent).toContain("disabled");
    const calls = settingsService.resolveModelConfig.mock.calls.length;
    fireEvent.change(id, { target: { value: "" } });
    fireEvent.blur(id);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(settingsService.resolveModelConfig).toHaveBeenCalledTimes(calls);
  });
  it("添加等待真实保存，失败保留草稿并允许重试", async () => {
    const config = createModelProviderModelConfig({ id: "new-model" }).config;
    settingsService.resolveModelConfig.mockResolvedValue({
      inheritedConfig: config,
      effectiveConfig: config,
      issues: [],
      revision: 1,
    });
    let rejectSave!: (error: Error) => void;
    const onAddModel = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [] }),
        onSave: vi.fn(),
        onAddPersonalModel: () => onAddModel(),
      }),
    );
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON));
    fireEvent.change(document.querySelector('[data-model-identity-row="true"] input')!, {
      target: { value: "new-model" },
    });
    fireEvent.blur(document.querySelector('[data-model-identity-row="true"] input')!);
    await waitFor(() => expect(settingsService.resolveModelConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(onAddModel).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-model-identity-row="true"] input')).not.toBeNull();
    await act(async () => {
      rejectSave(new Error("disk write failed"));
    });
    expect(screen.getByText("disk write failed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重试", exact: true })).toBeNull();
    expect(
      (document.querySelector('[data-model-identity-row="true"] input') as HTMLInputElement).value,
    ).toBe("new-model");
    onAddModel.mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() =>
      expect(document.querySelector('[data-model-identity-row="true"] input')).toBeNull(),
    );
    expect(onAddModel).toHaveBeenCalledTimes(2);
  });
  it("Todo89：View 刷新不丢编辑草稿，冲突保留输入，重新打开才读取新基线", async () => {
    const model = createModelProviderModelConfig({ id: "draft-model" });
    const onCommit = vi.fn().mockRejectedValue(new Error("revision conflict"));
    const props = { model, providerId: "test", onCommit, settingsRevision: 7 };
    const rendered = renderWithProviderFeedback(createElement(ModelRowInput, props));
    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    fireEvent.change(document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!, {
      target: { value: "123456" },
    });
    rendered.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(ModelRowInput, {
          ...props,
          model: structuredClone(model),
          settingsRevision: 8,
        }),
      ),
    );
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(onCommit.mock.calls[0]?.[1]).toBe(7);
    expect(await screen.findByText("revision conflict")).toBeTruthy();
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("200000");
  });

  it("Todo89：不完整模型保留修复、启停与个人成员删除入口", () => {
    const model = createModelProviderModelConfig({ id: "broken" });
    model.config = {};
    model.personalConfig = {};
    model.executable = false;
    render(
      createElement(ProviderModelsSection, {
        providerId: "test",
        models: [model],
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );
    expect(screen.getByLabelText("编辑模型配置")).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"))).toBeTruthy();
    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("");
  });
  it("把添加模型操作放在模型列表标题行，而不是列表底部", () => {
    render(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [createModelProviderModelConfig({ id: "model-a" })],
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    const addButton = screen.getByTestId(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
    const modelsLabel = screen.getByText("模型列表");
    expect(addButton.parentElement).toBe(modelsLabel.parentElement);
    expect(addButton.dataset.variant).toBe("secondary");
    expect(addButton.dataset.size).toBe("default");
    expect(addButton.parentElement?.className).toContain("mb-1");
    expect(addButton.parentElement?.className).not.toContain("mt-2");
    expect(
      addButton.compareDocumentPosition(screen.getByText("model-a")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    const modelContent = screen
      .getByText("model-a")
      .closest("[data-model-provider-model-id]")?.firstElementChild;
    expect(modelContent?.classList.contains("px-3")).toBe(true);
    expect(modelContent?.classList.contains("py-2")).toBe(true);
    expect(modelContent?.classList.contains("p-2")).toBe(false);
  });

  it("未触碰 Model Draft 时保留原稀疏 Overlay，且不凭空写入默认 false", () => {
    const inherited = createModelProviderModelConfig({ id: "draft-model" });
    inherited.config.optionSpecs = {
      reasoningLevel: {
        values: ["low", "high"],
        map: "{'effort': reasoningLevel}",
      },
      maxOutputTokens: inherited.config.optionSpecs.maxOutputTokens,
    };
    const model = {
      ...inherited,
      personalConfig: {
        properties: { inputFormat: { supportsPdf: true } },
        optionSpecs: { reasoningLevel: { map: null } },
      },
      hasPersonalConfig: true,
      inheritedConfig: structuredClone(inherited.config),
      config: {
        ...inherited.config,
        properties: {
          ...inherited.config.properties,
          inputFormat: {
            ...inherited.config.properties.inputFormat,
            supportsPdf: true,
          },
        },
        optionSpecs: {
          ...inherited.config.optionSpecs,
          reasoningLevel: { ...inherited.config.optionSpecs?.reasoningLevel, map: null },
        },
      },
    };

    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: createProviderModelDraftValues(model),
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig).toEqual({
      properties: { inputFormat: { supportsPdf: true } },
    });
    expect(result.model.personalConfig).not.toHaveProperty("requiresMfjsToolSchema");
    expect(result.model.personalConfig.properties?.requiresMfjsToolSchema).toBeUndefined();
    expect(result.model.personalConfig.properties?.inputFormat?.supportsPdf).toBe(true);
  });

  it("只允许当前 Draft revision 的保存响应更新反馈", () => {
    expect(shouldApplyProviderSaveCompletion(3, 3)).toBe(true);
    expect(shouldApplyProviderSaveCompletion(4, 3)).toBe(false);
  });

  it("模型连接成功在 Provider 详情栏底部横幅显示完整身份", async () => {
    const model = createModelProviderModelConfig({ id: "deepseek-v4-flash" });
    renderWithProviderFeedback(
      createElement(ModelRowInput, {
        providerId: "deepseek",
        model,
        onCommit: vi.fn(async () => undefined),
        onTest: vi.fn(async () => ({ success: true as const })),
      }),
    );

    fireEvent.click(screen.getByTitle("测试模型"));

    expect(screen.getByText("deepseek / deepseek-v4-flash 正在连接")).toBeTruthy();
    await screen.findByText("deepseek / deepseek-v4-flash 连接成功");
    expect(screen.getByTestId("provider-detail-feedback-viewport")).toBeTruthy();
    expect(screen.queryByText("连接成功！")).toBeNull();
    expect(screen.getByRole("status").className).toContain("bg-success/10");
    expect(screen.getByRole("status").className).toContain("text-success");
    expect(screen.getByRole("status").querySelector("button")).not.toBeNull();
  });

  it.each(["success", "failure", "throw"])(
    "连接测试 %s 使用显示名称，身份参数不变",
    async (outcome) => {
      const provider = createProvider();
      const onTestModel = vi.fn(async () => {
        if (outcome === "throw") throw new Error("network-error");
        return outcome === "success"
          ? { success: true as const }
          : { success: false as const, error: { message: "auth-error" } };
      });
      renderWithProviderFeedback(
        createElement(InlineEditableProviderCard, { provider, onSave: vi.fn(), onTestModel }),
      );
      fireEvent.click(screen.getAllByTitle("测试模型")[0]!);
      expect(screen.getByText(/DeepSeek .*正在连接/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen.getByText(outcome === "success" ? /DeepSeek .*连接成功/ : /DeepSeek .*连接失败/),
        ).toBeTruthy(),
      );
      expect(onTestModel).toHaveBeenCalledWith(provider.providerId, provider.models[0]!.modelId);
    },
  );

  it("禁用 Provider 时测试不可触发，重新启用保留测试能力", async () => {
    const provider = createProvider({ enabled: false });
    const onTestModel = vi.fn(async () => ({ success: true as const }));
    const onSave = vi.fn();
    const mounted = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider, onSave, onTestModel }),
    );
    const testButton = screen.getAllByTitle(
      "settings.modelProvider.testModel.enableProviderFirst",
    )[0] as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);
    fireEvent.click(testButton);
    expect(onTestModel).not.toHaveBeenCalled();
    mounted.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(InlineEditableProviderCard, {
          provider: { ...provider, enabled: true },
          onSave,
          onTestModel,
        }),
      ),
    );
    fireEvent.click(screen.getAllByTitle("测试模型")[0]!);
    await waitFor(() => expect(onTestModel).toHaveBeenCalledTimes(1));
  });

  it("Provider 改名后的新测试使用新名称，无名称回退身份", async () => {
    const onTestModel = vi.fn(async () => ({ success: true as const }));
    const onSave = vi.fn();
    const provider = createProvider();
    const mounted = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider, onSave, onTestModel }),
    );
    for (const name of ["Account Plan", "Renamed", ""]) {
      mounted.rerender(
        createElement(
          ProviderDetailFeedbackBoundary,
          null,
          createElement(InlineEditableProviderCard, {
            provider: { ...provider, providerName: name },
            onSave,
            onTestModel,
          }),
        ),
      );
      fireEvent.click(screen.getAllByTitle("测试模型")[0]!);
      expect(
        await screen.findByText(
          `${name || provider.providerId} / ${provider.models[0]!.modelId} 连接成功`,
        ),
      ).toBeTruthy();
    }
    expect(onTestModel.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [provider.providerId, provider.models[0]!.modelId]),
    );
  });

  it.each(["provider-unavailable", "model-unavailable"] as const)(
    "资格错误 %s 使用本地化提示",
    async (code) => {
      renderWithProviderFeedback(
        createElement(ModelRowInput, {
          providerId: "p",
          model: createModelProviderModelConfig({ id: "m" }),
          onCommit: vi.fn(),
          onTest: vi.fn(async () => ({
            success: false as const,
            error: { code, message: "fallback" },
          })),
        }),
      );
      fireEvent.click(screen.getByTitle("测试模型"));
      expect(
        await screen.findByText(
          `p / m 连接失败：settings.modelProvider.testModel.${code === "provider-unavailable" ? "providerUnavailable" : "modelUnavailable"}`,
        ),
      ).toBeTruthy();
    },
  );

  it("不显示 dirty，saving 与 success 在 Provider 详情栏按同一 key 替换", async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    expect(baseUrl.getAttribute("data-testid")).toBe(TID_MODEL_PROVIDER_BASE_URL_INPUT);
    expect(screen.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER)).toBeTruthy();

    fireEvent.change(baseUrl, { target: { value: "https://next.example.com" } });
    expect(screen.queryByTestId("model-provider-save-status")).toBeNull();
    fireEvent.blur(baseUrl);
    expect(screen.queryByTestId("model-provider-save-status")).toBeNull();
    expect(screen.getByText("DeepSeek 正在保存")).toBeTruthy();
    resolveSave?.();

    const successMessage = await screen.findByText("DeepSeek 保存成功");
    const successFeedback = successMessage.closest<HTMLElement>(
      '[data-provider-detail-feedback-state="success"]',
    );
    expect(successFeedback?.classList.contains("w-full")).toBe(true);
    expect(successFeedback?.classList.contains("w-fit")).toBe(false);
    expect(successFeedback?.classList.contains("self-start")).toBe(false);
    expect(successFeedback?.classList.contains("rounded-xl")).toBe(true);
    expect(successFeedback?.classList.contains("rounded-lg")).toBe(false);
    expect(successFeedback?.className).toContain("border-border");
    expect(successFeedback?.className).toContain("bg-popover/95");
    expect(successFeedback?.className).toContain("text-foreground");
    expect(successFeedback?.className).not.toContain("border-success/30");
    expect(successFeedback?.className).not.toContain("bg-success/10");
    expect(successFeedback?.querySelector("svg")?.classList.contains("text-success")).toBe(true);
    expect(screen.queryByText("DeepSeek 正在保存")).toBeNull();
  });

  it("Provider 文本输入停顿后自动保存，失焦会 flush 且不重复提交", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => undefined);
    render(createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }));
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    fireEvent.change(baseUrl, { target: { value: "https://idle.example.com" } });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS - 1);
    });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].config.api?.baseUrl).toBe("https://idle.example.com");

    fireEvent.blur(baseUrl);
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("API Key 闲时保存，名称必须确认且 IME 结束不自动保存", async () => {
    vi.useFakeTimers();
    const apiKeySave = vi.fn(async () => undefined);
    const apiKeyView = render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave: apiKeySave,
      }),
    );
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT), {
      target: { value: "sk-idle" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(apiKeySave.mock.calls[0]?.[0].config.access).toMatchObject({ apiKey: "sk-idle" });
    apiKeyView.unmount();

    const nameSave = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave: nameSave,
        nameEditable: true,
      }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const nameInput = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.compositionStart(nameInput);
    fireEvent.change(nameInput, {
      target: { value: "DeepSeek Idle" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(nameSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(nameInput);
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(nameSave).not.toHaveBeenCalled();
    fireEvent.blur(nameInput);
    expect(nameSave.mock.calls[0]?.[0].providerName).toBe("DeepSeek Idle");
    expect(nameSave.mock.calls[0]?.[0].providerNameUpdate).toBe("DeepSeek Idle");
  });

  it("名称 Esc 取消后 blur、闲时和卸载均不保存；Key 自动保存不夹带名称", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => undefined);
    const view = render(
      createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT), {
      target: { value: "sk-confirmed" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("providerNameUpdate");
    expect(onSave.mock.calls[0]?.[0].config.access.apiKey).toBe("sk-confirmed");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    view.unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("名称正式 Enter 只确认一次，标题空白和更多菜单不切换启停", async () => {
    const onSave = vi.fn(async () => undefined);
    render(createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }));
    const toggle = screen.getByTestId("model-provider-enabled-switch");
    expect(toggle.closest("label")).toBeNull();
    fireEvent.click(screen.getByTestId("model-provider-header"));
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    input.focus();
    fireEvent.change(input, { target: { value: "Confirmed" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      providerNameUpdate: "Confirmed",
      enabled: true,
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("enabledUpdate");
  });

  it.each([false, true])("菜单删除仍走既有确认，confirmed=%s", async (confirmed) => {
    const provider = createProvider();
    const confirmDialog = vi.fn(async () => confirmed);
    const deleteProvider = vi.fn(async () => undefined);
    const intl = { formatMessage: ({ id }: { id: string }) => id } as Parameters<
      typeof confirmAndDeleteModelProvider
    >[0]["intl"];
    const onSave = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave,
        onDelete: () =>
          confirmAndDeleteModelProvider({ provider, confirmDialog, deleteProvider, intl }),
      }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "common.delete" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(deleteProvider).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    if (confirmed) expect(deleteProvider).toHaveBeenCalledWith(provider.providerId);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("名称保存失败可重试同一次确认，切换供应商后不补发未确认名称", async () => {
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue();
    const provider = createProvider();
    const view = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider, onSave }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.change(input, { target: { value: "Retry name" } });
    fireEvent.blur(input);
    await screen.findByText("DeepSeek 保存失败：disk full");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[0]?.[0]).toEqual(onSave.mock.calls[1]?.[0]);
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), { key: "Enter" });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT), {
      target: { value: "Discard on switch" },
    });
    view.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(InlineEditableProviderCard, {
          provider: createProvider({ providerId: "other", providerName: "Other" }),
          onSave,
        }),
      ),
    );
    expect(screen.queryByTestId(TID_MODEL_PROVIDER_NAME_INPUT)).toBeNull();
    view.unmount();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("外部 View 更新时保留 dirty 字段，并更新未编辑字段", () => {
    const initial = createProvider();
    const view = render(
      createElement(InlineEditableProviderCard, { provider: initial, onSave: vi.fn() }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com") as HTMLInputElement;

    fireEvent.change(baseUrl, { target: { value: "https://draft.example.com" } });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          personalConfig: {
            ...initial.personalConfig,
            access: { type: "api-key", apiKey: "sk-external" },
            api: { type: "anthropic-messages", baseUrl: "https://external.example.com" },
          },
          config: {
            ...initial.config,
            access: { type: "api-key", apiKey: "sk-external" },
            api: { type: "anthropic-messages", baseUrl: "https://external.example.com" },
          },
        }),
        onSave: vi.fn(),
      }),
    );

    expect(baseUrl.value).toBe("https://draft.example.com");
    expect((screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT) as HTMLInputElement).value).toBe(
      "sk-external",
    );
  });

  it("Base URL 按 Enter 会结束编辑并提交完整草稿", async () => {
    const onSave = vi.fn(async () => {});
    render(createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }));
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    baseUrl.focus();
    fireEvent.change(baseUrl, { target: { value: "https://enter.example.com" } });
    fireEvent.keyDown(baseUrl, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].config.api?.baseUrl).toBe("https://enter.example.com");
  });

  it("中文输入法用 Enter 确认 Base URL 候选时不会提交", async () => {
    const onSave = vi.fn(async () => {});
    render(createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }));
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    baseUrl.focus();
    fireEvent.change(baseUrl, { target: { value: "https://中文.example.com" } });
    fireEvent.compositionStart(baseUrl);
    fireEvent.keyDown(baseUrl, { key: "Enter" });

    await act(async () => undefined);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(baseUrl);

    fireEvent.compositionEnd(baseUrl);
    fireEvent.keyDown(baseUrl, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("Template 实例展示冻结的 Endpoint、Schema，并保留 API Key 与模型配置", () => {
    const provider = createProvider({
      config: {
        ...createProvider().config,
        group: "standard-personal",
        templateId: "deepseek",
      },
    });
    render(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave: vi.fn(),
        readOnlyEndpoints: true,
        nameEditable: false,
      }),
    );

    expect(screen.queryByTestId(TID_MODEL_PROVIDER_BASE_URL_INPUT)).toBeNull();
    expect(screen.queryByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER)).toBeNull();
    expect(screen.getByText("https://api.deepseek.com")).toBeTruthy();
    expect(screen.getByText("Anthropic Messages (/v1/messages)")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Base URL（只读）" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "API 格式（只读）" })).toBeTruthy();
    expect(screen.queryByTestId("model-provider-name-edit-button")).toBeNull();
    expect(screen.queryByTestId("model-provider-actions-button")).toBeNull();
    expect(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT)).toBeTruthy();
    expect(screen.getByText("deepseek-v4-flash")).toBeTruthy();
  });

  it("保存失败替换底部 saving、延长停留并提供重试", async () => {
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce();
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider: createProvider(), onSave }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    fireEvent.change(baseUrl, { target: { value: "https://next.example.com" } });
    fireEvent.blur(baseUrl);
    await screen.findByText("DeepSeek 保存失败：disk full");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it("按拖动的模型 ID 生成新顺序", () => {
    expect(
      resolveReorderedModelIds({
        activeModelId: "model-b",
        overModelId: "model-a",
        modelIds: ["model-a", "model-b", "model-c"],
      }),
    ).toEqual(["model-b", "model-a", "model-c"]);
  });

  it("模型列表只保留单层外框，最后一行不绘制额外 divider", () => {
    render(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({ id: "model-a" }),
          createModelProviderModelConfig({ id: "model-b" }),
        ],
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    const rows = screen.getAllByLabelText("settings.modelProvider.reorderModel");
    const list = rows[0]!.parentElement;
    expect(list?.className).not.toContain("divide-y");
    expect(rows[0]!.className).toContain("border-b");
    expect(rows[1]!.className).toContain("border-b-0");
  });

  it("拖动中的模型行隐藏底部分隔线但保留透明边框占位", () => {
    const className = resolveSortableProviderModelRowClassName({
      isDragging: true,
      isLast: false,
    });

    expect(className).toContain("border-b");
    expect(className).toContain("border-transparent");
    expect(className).not.toContain("border-input-border");
  });

  it("模型名称可启动整行拖动，真实交互控件不会误触拖动", () => {
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    const name = document.createElement("span");
    const action = document.createElement("button");
    row.append(name, action);

    expect(isInteractiveModelDragTarget(name)).toBe(false);
    expect(isInteractiveModelDragTarget(action)).toBe(true);
  });

  it("模型弹窗和遮罩通过 Portal 冒泡到模型行时也不会启动背景拖动", () => {
    const dialog = document.createElement("section");
    dialog.setAttribute("data-slot", "dialog-content");
    const dialogBlankArea = document.createElement("div");
    dialog.append(dialogBlankArea);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");

    expect(isInteractiveModelDragTarget(dialogBlankArea)).toBe(true);
    expect(isInteractiveModelDragTarget(overlay)).toBe(true);
  });

  it.each(["input", "textarea", "select", "button", "a", "editable", "portal"])(
    "键盘空格在 %s 中不启动背景模型拖拽",
    (kind) => {
      const target =
        kind === "portal"
          ? createPortal(
              createElement("section", {
                "data-slot": "dialog-content",
                "data-testid": "key-target",
              }),
              document.body,
            )
          : createElement(kind === "editable" ? "div" : kind, {
              "data-testid": "key-target",
              ...(kind === "editable" ? { contentEditable: true } : {}),
            });
      const onReorder = vi.fn();
      render(
        createElement(SortableProviderModelList, {
          modelIds: ["one", "two"],
          onReorder,
          renderModel: (id) => (id === "one" ? target : id),
        }),
      );
      const control = screen.getByTestId("key-target");
      expect(fireEvent.keyDown(control, { key: " ", code: "Space" })).toBe(true);
      expect(
        screen
          .getAllByLabelText("settings.modelProvider.reorderModel")[0]!
          .getAttribute("aria-pressed"),
      ).not.toBe("true");
      expect(onReorder).not.toHaveBeenCalled();
    },
  );

  it("模型行自身的空格仍启动键盘拖拽", () => {
    const onReorder = vi.fn();
    render(
      createElement(SortableProviderModelList, {
        modelIds: ["one", "two"],
        onReorder,
        renderModel: (id) => id,
      }),
    );
    const row = screen.getAllByLabelText("settings.modelProvider.reorderModel")[0]!;
    expect(fireEvent.keyDown(row, { key: " ", code: "Space" })).toBe(false);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("模型行按图片能力显示视觉标记，而非按型号猜测", () => {
    const model = createModelProviderModelConfig({ id: "unknown-vision-model" });
    model.config.properties!.inputFormat!.supportsImage = true;
    const { rerender } = render(
      createElement(ModelRowInput, { providerId: "provider-demo", model, onCommit: vi.fn() }),
    );
    expect(screen.getByLabelText("视觉")).toBeTruthy();
    const textOnly = createModelProviderModelConfig({ id: "GLM-5.3" });
    rerender(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: textOnly,
        onCommit: vi.fn(),
      }),
    );
    expect(screen.queryByLabelText("视觉")).toBeNull();
  });

  it("Model Draft 等待 Host 原子保存成功后才关闭弹窗", async () => {
    let resolveSave!: () => void;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
        settingsRevision: 9,
      }),
    );

    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ modelId: "draft-model" }), 9),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("中文输入法用 Enter 确认 Model ID 候选时不会保存", async () => {
    const onCommit = vi.fn(async () => undefined);
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
      }),
    );

    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    const modelIdInput = screen.getByDisplayValue("draft-model");
    fireEvent.compositionStart(modelIdInput);
    fireEvent.keyDown(modelIdInput, { key: "Enter" });

    await act(async () => undefined);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.compositionEnd(modelIdInput);
    fireEvent.keyDown(modelIdInput, { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
  });

  it("Model Draft 保存失败时保留弹窗、草稿和明确错误", async () => {
    const onCommit = vi.fn(async () => {
      throw new Error("revision conflict");
    });
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
        settingsRevision: 4,
      }),
    );

    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    fireEvent.change(screen.getByDisplayValue("draft-model"), {
      target: { value: "renamed-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("revision conflict")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("renamed-model")).toBeTruthy();
  });

  it("Model ID Resolution 丢弃晚到的旧响应", async () => {
    const baseModel = createModelProviderModelConfig({ id: "draft-model" });
    const model = {
      ...baseModel,
      personalConfig: {},
      inheritedConfig: structuredClone(baseModel.config),
      hasPersonalConfig: false,
    };
    const resolvers = new Map<
      string,
      (resolution: {
        inheritedConfig: typeof baseModel.config;
        effectiveConfig: typeof baseModel.config;
        issues: [];
      }) => void
    >();
    const onResolveDraft = vi.fn(
      (nextModelId: string) =>
        new Promise<{
          inheritedConfig: typeof baseModel.config;
          effectiveConfig: typeof baseModel.config;
          issues: [];
        }>((resolve) => resolvers.set(nextModelId, resolve)),
    );
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(async () => undefined),
        onResolveDraft,
      }),
    );

    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    const modelIdInput = screen.getByDisplayValue("draft-model");
    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    fireEvent.blur(modelIdInput);
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalledWith("first-model", {}));
    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    fireEvent.blur(modelIdInput);
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalledWith("second-model", {}));

    const secondConfig = structuredClone(baseModel.config);
    secondConfig.properties!.contextWindow = 222_000;
    resolvers.get("second-model")?.({
      inheritedConfig: secondConfig,
      effectiveConfig: secondConfig,
      issues: [],
    });
    const contextWindowInput = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("222000"));

    const firstConfig = structuredClone(baseModel.config);
    firstConfig.properties!.contextWindow = 111_000;
    resolvers.get("first-model")?.({
      inheritedConfig: firstConfig,
      effectiveConfig: firstConfig,
      issues: [],
    });
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("222000"));
  });

  it("关闭跟随时物化当前草稿，不丢失尚未保存的编辑", () => {
    const base = createModelProviderModelConfig({ id: "draft-model" });
    const model = { ...base, inheritedConfig: structuredClone(base.config), personalConfig: {} };
    render(createElement(ModelRowInput, { providerId: "provider-demo", model, onCommit: vi.fn() }));
    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    const context = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    fireEvent.change(context, { target: { value: "345000" } });
    fireEvent.click(screen.getByRole("switch", { name: "跟随推荐配置" }));
    expect(context.value).toBe("345000");
    expect(context.placeholder).toBe("");
  });

  it("重命名解析后关闭跟随使用新 Model ID 的继承事实", async () => {
    const original = createModelProviderModelConfig({ id: "draft-model", supportsTools: true });
    const model = {
      ...original,
      personalConfig: { properties: { contextWindow: 300_000 } },
      hasPersonalConfig: true,
      inheritedConfig: structuredClone(original.config),
      config: {
        ...original.config,
        properties: { ...original.config.properties, contextWindow: 300_000 },
      },
    };
    const renamedInherited = createModelProviderModelConfig({
      id: "renamed-model",
      contextWindow: 100_000,
      supportsTools: false,
    }).config;
    const onResolveDraft = vi.fn(async () => ({
      inheritedConfig: renamedInherited,
      effectiveConfig: {
        ...renamedInherited,
        properties: { ...renamedInherited.properties, contextWindow: 300_000 },
      },
      issues: [],
    }));
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(async () => undefined),
        onResolveDraft,
      }),
    );

    fireEvent.click(screen.getByLabelText("编辑模型配置"));
    fireEvent.change(screen.getByDisplayValue("draft-model"), {
      target: { value: "renamed-model" },
    });
    fireEvent.blur(screen.getByDisplayValue("renamed-model"));
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalled());
    const contextWindowInput = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("100000"));

    fireEvent.click(screen.getByRole("switch", { name: "跟随推荐配置" }));

    expect(screen.getByRole("switch", { name: "跟随推荐配置" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value).toBe(
        "300000",
      ),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.placeholder,
    ).toBe("");
  });

  it("上下文窗口展示为紧凑 token 容量", () => {
    expect(formatModelContextWindowLabel(999)).toBe("999");
    expect(formatModelContextWindowLabel(128000)).toBe("128K");
    expect(formatModelContextWindowLabel(1500000)).toBe("1.5M");
    expect(formatModelContextWindowLabel(1000000)).toBe("1M");
    expect(formatModelContextWindowLabel(128000, "zh-CN")).toBe("128K");
    expect(formatModelContextWindowLabel(1000000, "zh-CN")).toBe("1M");
  });

  it("Provider 使用统一 API 格式枚举，不再从模型 kinds 反推", () => {
    expect(resolveProviderApiFormatOptions(createProvider())).toEqual([
      "anthropic-messages",
      "openai-chat-completions",
      "openai-responses",
    ]);
  });

  it("默认只展示紧凑模型行，metadata 编辑入口收进弹窗", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "deepseek-v3.2",
            name: "DeepSeek V3.2",
            contextWindow: 128000,
            maxOutputTokens: 4096,
            defaultKind: "openai-compatible",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("deepseek-v3.2");
    expect(html).toContain(">128K<");
    expect(html).toContain('aria-label="上下文窗口：128K"');
    expect(html).toContain('aria-label="编辑模型配置"');
    expect(html).not.toContain("显示名称");
    expect(html).not.toContain("最大输出 Token");
  });

  it("只在提供 Personal Model 调序入口时渲染拖动 handle", () => {
    const common = {
      providerId: "test-provider",
      models: [
        createModelProviderModelConfig({
          id: "deepseek-v3.2",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          defaultKind: "openai-compatible" as const,
          kinds: ["openai-compatible" as const],
        }),
      ],
      apiKeyValue: "sk-demo",
      onModelCommit: vi.fn(),
      onDeleteModel: vi.fn(),
      onAddModel: vi.fn(),
    };

    expect(
      renderToStaticMarkup(
        createElement(ProviderModelsSection, {
          ...common,
          onReorderModelIds: vi.fn(),
        }),
      ),
    ).toContain('aria-label="settings.modelProvider.reorderModel"');
    expect(renderToStaticMarkup(createElement(ProviderModelsSection, common))).not.toContain(
      'aria-label="settings.modelProvider.reorderModel"',
    );
  });

  it("Built-in 模型不可删除但可调序、编辑覆盖和写入稀疏 enabled Overlay", () => {
    const model = {
      ...createModelProviderModelConfig({ id: "builtin-model" }),
      builtin: true,
      personalConfig: {},
      hasPersonalConfig: false,
    };
    const onModelCommit = vi.fn();
    const onModelEnabledChange = vi.fn();
    render(
      createElement(ProviderModelsSection, {
        providerId: "builtin-provider",
        models: [model],
        apiKeyValue: "sk-demo",
        onModelCommit,
        onModelEnabledChange,
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    expect(screen.getByText("builtin-model")).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"))).toBeNull();
    expect(screen.getByLabelText("settings.modelProvider.reorderModel")).toBeTruthy();
    expect(screen.getByLabelText("编辑模型配置")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "停用" }));
    expect(onModelEnabledChange).toHaveBeenCalledWith("builtin-model", false);
    expect(onModelCommit).not.toHaveBeenCalled();
  });

  it("Provider 卡片的 Model enabled 只提交启停叶子，不回传模型草稿", async () => {
    const model = {
      ...createModelProviderModelConfig({ id: "builtin-model" }),
      builtin: true,
      personalConfig: {},
      hasPersonalConfig: false,
    };
    const onSave = vi.fn(async () => undefined);
    const onSavePersonalModelDraft = vi.fn(async () => undefined);
    const onSetPersonalModelEnabled = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [model] }),
        onSave,
        onSavePersonalModelDraft,
        onSetPersonalModelEnabled,
        settingsRevision: 7,
      }),
    );

    fireEvent.click(screen.getByRole("switch", { name: "停用" }));

    await waitFor(() => expect(onSetPersonalModelEnabled).toHaveBeenCalledTimes(1));
    expect(onSetPersonalModelEnabled).toHaveBeenCalledWith(
      "provider-deepseek",
      "builtin-model",
      false,
    );
    expect(onSavePersonalModelDraft).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Built-in/Personal 重名时保留 Built-in 成员且模型开关不展示恢复默认", () => {
    const model = {
      ...createModelProviderModelConfig({ id: "same-id" }),
      builtin: true,
      hasPersonalConfig: true,
      personalConfig: { enabled: false },
    };
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "builtin-provider",
        models: [model],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    expect(html).toContain(">same-id</span>");
    expect(html).not.toContain('<input type="text"');
    expect(html).not.toContain('aria-label="删除"');
    expect(html).not.toContain("恢复默认");
    expect(html).toContain('aria-label="编辑模型配置"');
    expect(html).toContain('aria-label="settings.modelProvider.reorderModel"');
    expect(html).toContain("select-none");
  });

  it("上下文长度紧跟模型名，模型开关固定在全部行操作最右侧", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [createModelProviderModelConfig({ id: "model-a", contextWindow: 128000 })],
        apiKeyValue: "sk-demo",
        onTestModel: vi.fn(),
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    expect(html.indexOf("model-a")).toBeLessThan(html.indexOf(">128K<"));
    expect(html.indexOf(">128K<")).toBeLessThan(html.indexOf('title="测试模型"'));
    expect(html.indexOf('aria-label="编辑模型配置"')).toBeLessThan(
      html.indexOf('aria-label="停用"'),
    );
  });

  it("模型行展示配置中的上下文窗口，不按模型后缀改写", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "deepseek-v4-pro[1m]",
            contextWindow: 128000,
            defaultKind: "openai-compatible",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("deepseek-v4-pro[1m]");
    expect(html).toContain(">128K<");
    expect(html).toContain('aria-label="上下文窗口：128K"');
  });

  it("模型行右侧不展示 API 格式 pill 标签，且不按 kind 禁用测试按钮", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "anthropic-model",
            kinds: ["anthropic"],
          }),
          createModelProviderModelConfig({
            id: "openai-compatible-model",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onTestModel: vi.fn(),
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("anthropic-model");
    expect(html).toContain("openai-compatible-model");
    expect(html).not.toContain("当前 API 格式不可用");
    expect(html).not.toContain('data-api-format-kind="anthropic"');
    expect(html).not.toContain('data-api-format-kind="openai-compatible"');
    expect(html).not.toContain('data-api-format-kind="openai"');
    expect(html).not.toContain(">Anthropic<");
    expect(html).not.toContain(">Chat<");
    expect(html).not.toContain('data-api-format-active="true"');
    expect(html).not.toContain("grid-template-columns:repeat(2, minmax(max-content, 1fr))");
    expect(html.match(/title="测试模型"/g)).toHaveLength(2);
    expect(html).not.toContain('disabled=""');
  });

  it("无模型时不渲染空的模型列表容器", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("模型列表");
    expect(html).toContain("添加模型");
    expect(html).not.toContain("mt-1 rounded-lg bg-input border border-input-border");
  });

  it("删除收到权威 View 后才移除模型，不靠本地行消失冒充成功", async () => {
    const onSave = vi.fn();
    const onDeletePersonalModel = vi.fn(async () => undefined);
    const provider = createProvider({
      models: [createModelProviderModelConfig({ id: "user-added-model" })],
    });
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          models: [
            createModelProviderModelConfig({
              id: "user-added-model",
              kinds: ["openai-compatible"],
            }),
          ],
        }),
        onSave,
        onDeletePersonalModel,
      }),
    );

    fireEvent.click(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0")));
    expect(screen.queryByText("user-added-model")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: { ...provider, models: [] },
        onSave,
        onDeletePersonalModel,
      }),
    );
    expect(screen.queryByText("user-added-model")).toBeNull();
    const emptyState = screen.getByText("当前没有配置模型，添加模型后可在聊天中使用。");
    expect(emptyState.className).toContain("border-dashed");
    expect(emptyState.className).toContain("h-12");
    expect(emptyState.className).not.toContain("h-[50px]");
    expect(emptyState.className).not.toContain("py-4");
    expect(emptyState.className).not.toContain("py-8");
    expect(emptyState.className).toContain("rounded-lg");
    expect(emptyState.className).not.toContain("rounded-xl");
    expect(emptyState.className).toContain("justify-start");
    expect(emptyState.className).toContain("text-left");
    expect(emptyState.className).not.toContain("justify-center");
    expect(emptyState.className).not.toContain("text-center");
    expect(emptyState.className).toContain("border-border");
    expect(emptyState.querySelector("svg")).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDeletePersonalModel).toHaveBeenCalledWith("provider-deepseek", "user-added-model");
  });

  it("删除按钮的 mouse down 不触发模型行拖动", () => {
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          models: [
            createModelProviderModelConfig({
              id: "focused-model",
              kinds: ["openai-compatible"],
            }),
          ],
        }),
        onSave: vi.fn(),
      }),
    );

    const deleteButton = screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"));

    expect(fireEvent.mouseDown(deleteButton)).toBe(false);
  });

  it("删除失败不回滚成旧列表，也不覆盖等待期间到达的 View", async () => {
    let rejectDelete!: (error: Error) => void;
    const onDeletePersonalModel = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    const provider = createProvider({
      models: [createModelProviderModelConfig({ id: "managed-remote-model" })],
    });
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave: vi.fn(),
        onDeletePersonalModel,
      }),
    );
    fireEvent.click(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0")));
    const refreshed = {
      ...provider,
      models: [...provider.models, createModelProviderModelConfig({ id: "external-new-model" })],
    };
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: refreshed,
        onSave: vi.fn(),
        onDeletePersonalModel,
      }),
    );
    await act(async () => {
      rejectDelete(new Error("disk write failed"));
    });
    expect(screen.queryByText("managed-remote-model")).not.toBeNull();
    expect(screen.queryByText("external-new-model")).not.toBeNull();
  });
});
