import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderModelMetadataDialog,
  selectFocusedInputText,
} from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";

function extractInputTag(html: string, needle: string) {
  return html.match(/<input[^>]*>/g)?.find((tag) => tag.includes(needle)) ?? "";
}

function extractButtonOpeningTag(html: string, label: string) {
  return html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0].split(">", 1)[0] ?? "";
}

const MODEL_FORMAT_DRAFT = {
  reasoningLevelValuesValue: ["disabled"] as readonly string[],
  reasoningLevelMapValue: "",
  inputFormatValue: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
};

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogContent: ({
    children,
    className,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => createElement("section", { className, ...props }, children),
  DialogDescription: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("p", { className }, children),
  DialogFooter: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("footer", { className }, children),
  DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("header", { className }, children),
  DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("h2", { className }, children),
  DialogTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("div", { className }, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "common.cancel": "取消",
          "common.loading": "加载中...",
          "common.save": "保存",
          "settings.modelProvider.resetForm": "重置表单",
          "settings.modelProvider.followRecommendedConfig": "跟随推荐配置",
          "settings.modelProvider.addModel": "添加模型",
          "settings.modelProvider.apiFormat": "API 格式",
          "settings.modelProvider.apiFormat.anthropicMessages":
            "Anthropic Messages (/anthropic/v1/messages)",
          "settings.modelProvider.apiFormat.chatCompletions":
            "Chat Completions (/v1/chat/completions)",
          "settings.modelProvider.apiFormat.responses": "Responses (/responses)",
          "settings.modelProvider.apiFormat.short.anthropicMessages": "Anthropic",
          "settings.modelProvider.apiFormat.short.chatCompletions": "Chat",
          "settings.modelProvider.apiFormat.short.responses": "Responses",
          "settings.modelProvider.apiFormat.title.anthropicMessages": "Anthropic Messages",
          "settings.modelProvider.apiFormat.title.chatCompletions": "Chat Completions",
          "settings.modelProvider.apiFormat.title.responses": "Responses",
          "settings.modelProvider.contextWindow": "上下文窗口",
          "settings.modelProvider.capabilities": "模型能力",
          "settings.modelProvider.enableModel": "启用",
          "settings.modelProvider.advancedConfig": "高级配置",
          "settings.modelProvider.reasoning": "推理设置",
          "settings.modelProvider.editModel": "编辑模型配置",
          "settings.modelProvider.editModelDescription": "编辑模型配置描述",
          "settings.modelProvider.maxOutputTokens": "最大输出 Token",
          "settings.modelProvider.modelId": "模型 ID",
          "settings.modelProvider.inputModalities": "输入类型",
          "settings.modelProvider.outputModalities": "输出类型",
          "settings.modelProvider.otherSettings": "其他设置",
          "settings.modelProvider.modality.text": "Text",
          "settings.modelProvider.modality.image": "Image",
          "settings.modelProvider.modality.video": "Video",
          "settings.modelProvider.modality.audio": "Audio",
          "settings.modelProvider.modality.pdf": "PDF",
          "settings.modelProvider.modelMetadata.invalid.id": "模型 ID 不能为空",
          "settings.modelProvider.modelMetadata.invalid.kinds": "至少选择一种 API 格式",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

describe("ProviderModelMetadataDialog", () => {
  it.each([true, false])("Todo134：模型 ID 只读权限不随布局改变：%s", (modelIdReadOnly) => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        open: true,
        modelIdReadOnly,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "builtin-model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: () => true,
      }),
    );
    expect(extractInputTag(html, 'value="builtin-model"').includes('readOnly=""')).toBe(
      modelIdReadOnly,
    );
    expect(html).toContain('aria-expanded="false"');
  });
  it.each(["", "unknown"])("Todo130：ID=%s 无推荐/解析中/失败都能切换，只有保存禁用", (idValue) => {
    for (const pending of [false, true]) {
      for (const saving of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(ProviderModelMetadataDialog, {
            mode: "add",
            open: true,
            draft: {
              ...MODEL_FORMAT_DRAFT,
              idValue,
              contextWindowValue: "",
              maxOutputTokensValue: "",
            },
            draftErrorMessage: "failed",
            modelConfigResolutionPending: pending,
            saving,
            onOpenChange: vi.fn(),
            onDraftChange: vi.fn(),
            onCommit: vi.fn(() => true),
          }),
        );
        const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0];
        expect(toggle).toBeDefined();
        expect(toggle?.includes("disabled=")).toBe(saving);
      }
    }
  });
  it("Todo134：添加与编辑共用 footer 智能配置，布尔选项使用复选框", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        inheritedConfig: { properties: { contextWindow: 100000 } },
        draftErrorMessage: null,
        onOpenChange: () => {},
        onDraftChange: () => {},
        onCommit: () => true,
      }),
    );
    expect(html).toContain('data-model-recommended-config="true"');
    expect(html).toContain("data-model-option-checkbox");
    expect(html).not.toContain(">推理设置<");
  });

  it("Todo92：无效字段不影响独立覆盖标记，固定模式全部关闭标记", () => {
    const props = {
      open: true,
      draft: {
        ...MODEL_FORMAT_DRAFT,
        idValue: "model",
        contextWindowValue: "bad",
        maxOutputTokensValue: "",
        reasoningLevelMapValue: "bad (",
      },
      overrideFields: new Set([
        "contextWindowValue",
        "reasoningLevelValuesValue",
        "reasoningLevelMapValue",
      ]),
      draftErrorMessage: "invalid",
      onOpenChange: () => {},
      onDraftChange: () => {},
      onCommit: () => true,
    };
    const html = renderToStaticMarkup(createElement(ProviderModelMetadataDialog, props));
    expect(html).toContain('data-model-reasoning-chip="true" data-personal-override="true"');
    expect(extractInputTag(html, 'value="bad"')).toContain('data-personal-override="true"');
    const fixed = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        ...props,
        draft: { ...props.draft, useRecommendedConfigValue: false },
      }),
    );
    expect(fixed).not.toContain('data-personal-override="true"');
  });
  it("继承值只作为输入 placeholder，Reasoning 使用紧凑有序标签", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "deepseek-v4-flash",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "",
          maxOutputTokensValue: "",
          reasoningLevelValuesValue: ["low", "high"],
        },
        draftErrorMessage: null,
        personalConfig: {
          properties: {
            contextWindow: 1_200_000,
            supportsToolCall: false,
            inputFormat: { supportsImage: true },
          },
        },
        inheritedConfig: {
          properties: {
            contextWindow: 128_000,
            supportsToolCall: true,
            inputFormat: { supportsImage: false },
          },
          optionSpecs: {
            reasoningLevel: {
              values: ["low", "high"],
              map: "reasoningLevel == 'low'\n  ? {'reasoning_effort': 'low'}\n  : {'reasoning_effort': 'high'}",
            },
          },
        },
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain('inputMode="numeric"');
    expect(html).not.toContain('type="number"');
    expect(html).toContain("<textarea");
    expect(html).toContain('data-model-json-slot="true"');
    expect(html).toContain(
      'placeholder="reasoningLevel == &#x27;low&#x27;\n  ? {&#x27;reasoning_effort&#x27;: &#x27;low&#x27;}\n  : {&#x27;reasoning_effort&#x27;: &#x27;high&#x27;}"',
    );
    expect(html).toContain('data-model-reasoning-level-editor="true"');
    const reasoningLevelAddButton =
      html.match(/<button[^>]*data-model-reasoning-level-add="true"[^>]*>/)?.[0] ?? "";
    expect(reasoningLevelAddButton).toContain('data-variant="outline"');
    expect(reasoningLevelAddButton).toContain('data-size="icon-lg"');
    expect(html).toContain(">low<");
    expect(html).toContain(">high<");
    expect(html).toContain("高级配置");
    const reasoningGroup =
      html.match(/<section[^>]*data-model-settings-group="reasoning"[\s\S]*?<\/section>/)?.[0] ??
      "";
    const advancedGroup = html.slice(html.indexOf('data-model-advanced="true"'));
    expect(reasoningGroup).not.toContain(">推理设置<");
    expect(reasoningGroup).toContain('data-model-reasoning-level-editor="true"');
    expect(reasoningGroup).toContain('data-model-reasoning-level-map-editor="true"');
    expect(advancedGroup).toContain('data-model-reasoning-level-map-editor="true"');
    expect(reasoningGroup).not.toContain("settings.modelProvider.requiresMfjsToolSchema");
    expect(advancedGroup).not.toContain("settings.modelProvider.requiresMfjsToolSchema");
    expect(html).not.toContain('data-model-settings-advanced-trigger="true"');
    expect(html).toContain("settings.modelProvider.reasoningLevelsOrdered");
    expect(html).not.toContain("settings.modelProvider.requiresMfjsToolSchema");
    expect(html).not.toContain("settings.modelProvider.maxOutputTokensOptionSpecJson");
    expect(html).not.toContain("data-effective-json-preview");
    expect(html).not.toContain("settings.modelProvider.effectiveJsonPreview");
    expect(html).toContain('placeholder="128000"');
    expect(html).toContain('data-personal-override="true"');
    expect(html).not.toContain('aria-label="settings.modelProvider.restoreInheritedValue"');
    expect(html).toContain("max-w-2xl");
    expect(extractInputTag(html, 'value="deepseek-v4-flash"')).toContain('spellCheck="false"');
  });

  it("编辑弹窗在 Token 分组展示最大输出并提供跟随推荐配置开关", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "demo-model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        inheritedConfig: {
          properties: { contextWindow: 128_000 },
          optionSpecs: { maxOutputTokens: { max: 32_000 } },
        },
        personalConfig: { enabled: false },
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain("高级配置");
    expect(html).not.toContain('data-model-settings-advanced-trigger="true"');
    expect(html).toContain('data-model-advanced="true"');
    expect(html).toContain('data-model-reasoning-level-editor="true"');
    expect(html).toContain('data-model-settings-scroll="true"');
    expect(html).toContain("-mr-3");
    expect(html).toContain("pr-4");
    expect(extractInputTag(html, 'aria-label="最大输出 Token"')).toContain('placeholder="32000"');
    expect(html).toContain('data-model-recommended-config="true"');
    expect(html).toContain(">跟随推荐配置<");
    const footer = html.slice(html.indexOf('data-model-settings-footer="true"'));
    expect(footer).not.toContain('data-model-recommended-config="true"');
    expect(footer).not.toContain('role="switch"');
    expect(footer).toContain(">重置表单<");
    expect(footer.indexOf(">取消<")).toBeLessThan(footer.indexOf(">保存<"));
    expect(html.indexOf('data-model-max-output="true"')).toBeLessThan(
      html.indexOf('data-model-advanced="true"'),
    );
    expect(footer).toContain(">保存<");
    expect(footer).toContain(">取消<");
  });

  it("跟随推荐配置开关始终展示，且不存在旧的恢复默认按钮", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "personal-model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        inheritedConfig: {
          properties: { contextWindow: 128_000 },
          optionSpecs: { maxOutputTokens: { max: 32_000 } },
        },
        personalConfig: {},
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain('data-model-recommended-config="true"');
    expect(html).not.toContain("全部恢复默认");
    expect(html).not.toContain("settings.modelProvider.restoreInheritedValue");
  });

  it("模态与可编辑模型能力使用复选框选项，工具调用不再作为设置项", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "demo-model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        personalConfig: {
          properties: {
            inputFormat: { supportsImage: false },
            supportsToolCall: true,
          },
        },
        inheritedConfig: {
          properties: {
            contextWindow: 128_000,
            inputFormat: { supportsImage: false },
          },
        },
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const options = html.match(/<button[^>]*data-model-boolean-option="true"[^>]*>/g) ?? [];
    expect(options).toHaveLength(3);
    const capabilityOptions =
      html.match(/<button[^>]*data-model-capability-option="true"[^>]*>/g) ?? [];
    expect(capabilityOptions).toHaveLength(3);
    expect(capabilityOptions.every((option) => option.includes('role="checkbox"'))).toBe(true);
    expect(capabilityOptions.every((option) => option.includes("border-border"))).toBe(true);
    expect(capabilityOptions.every((option) => option.includes("bg-transparent"))).toBe(true);
    expect(
      capabilityOptions.every(
        (option) => option.includes("hover:bg-hover") && option.includes("focus-visible:bg-hover"),
      ),
    ).toBe(true);
    expect(html).not.toContain('data-model-capability-icon="true"');
    expect(html).not.toContain("settings.modelProvider.supportsToolCall");
    expect(html.match(/data-model-option-checkbox="true"/g)).toHaveLength(7);
    expect(html).toContain("data-model-option-checkbox");
    const overriddenModality =
      html.match(
        /<button[^>]*data-personal-override="true"[^>]*data-model-input-modality="image"[^>]*>/,
      )?.[0] ?? "";
    expect(overriddenModality).not.toBe("");
    expect(overriddenModality).toContain("border-primary/35");
    const selectedModalities =
      html.match(
        /<button[^>]*data-selected="true"[^>]*data-model-(?:input|output)-modality[^>]*>/g,
      ) ?? [];
    expect(selectedModalities).toHaveLength(1);
    expect(selectedModalities.every((option) => option.includes("bg-foreground/15"))).toBe(true);
    expect(html).not.toContain(">默认<");
    expect(html).not.toContain(">已修改<");
  });

  it("按任务顺序分组排列，常用分组不显示标题", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "demo-model",
          contextWindowValue: "",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain('data-model-identity-row="true"');
    expect(html).not.toContain('data-model-enabled-row="true"');
    expect(html).not.toContain("启用");
    expect(html).not.toContain('data-model-identity-enabled-layout="true"');
    expect(html).toContain('data-no-model-drag="true"');
    expect(html).toContain("max-h-[min(48rem,calc(100vh-4rem))]");
    const orderedGroups = ["basic", "tokens", "modalities", "capabilities"];
    const indexes = orderedGroups.map((group) =>
      html.indexOf(`data-model-settings-group="${group}"`),
    );
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(html).not.toContain("基本信息");
    expect(html).not.toContain("Token 限制");
    expect(html).not.toContain("输入与输出");
    expect(html).toContain("模型能力");
    const capabilitiesLabel =
      html.match(/<div[^>]*data-model-capabilities-label="true"[^>]*>/)?.[0] ?? "";
    expect(capabilitiesLabel).toContain("mb-1");
    expect(html).toContain('data-model-capabilities-options="true"');
    expect(html).toContain("高级配置");
  });

  it("模型后缀不会覆盖传入的上下文配置", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "deepseek-v4-pro[1m]",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "64000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const contextWindowInput = extractInputTag(html, 'inputMode="numeric"');

    expect(contextWindowInput).not.toContain("readOnly");
    expect(contextWindowInput).toContain('value="64000"');
  });

  it("编辑带后缀模型时仍聚焦上下文窗口", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "deepseek-v4-pro[1m]",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "64000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const modelIdInput = extractInputTag(html, 'placeholder="模型 ID"');
    const contextWindowInput = extractInputTag(html, 'inputMode="numeric"');

    expect(modelIdInput).not.toContain("autofocus");
    expect(contextWindowInput).toContain('autofocus=""');
  });

  it("打开弹窗默认聚焦上下文窗口", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "deepseek-v4-flash",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).not.toMatch(/placeholder="模型 ID"[^>]*autofocus/);
    expect(html).toMatch(/<input[^>]*autofocus[^>]*inputMode="numeric"[^>]*>/);
  });

  it("上下文窗口聚焦时会全选当前输入内容", () => {
    const select = vi.fn();

    selectFocusedInputText({
      currentTarget: {
        select,
      },
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("添加模型弹窗展示推理与高级分组、禁用必选 Text 并使用复选框模态选项", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "",
          nameValue: "",
          kindsValue: ["anthropic"],
          contextWindowValue: "1000000",
          maxOutputTokensValue: "128000",
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },

          modalitiesTouched: true,
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain("添加模型");
    expect(html).toContain("模型 ID");
    expect(html).not.toContain("API 格式");
    expect(html).not.toContain(">/anthropic/v1/messages<");
    expect(html).not.toContain(">/v1/chat/completions<");
    expect(html).not.toContain("Responses (/responses)");
    expect(html).toContain("上下文窗口");
    expect(html).toContain("最大输出 Token");
    expect(html).toContain("输入类型");
    expect(html).not.toContain('data-model-input-modalities-description="true"');
    expect(html).not.toContain("暂不支持作为附件");
    expect(html).not.toContain("输出类型");
    expect(html).toContain("高级配置");
    expect(html).not.toContain('data-model-settings-advanced-trigger="true"');
    expect(html).toContain('data-model-advanced="true"');
    expect(html).toContain('data-model-reasoning-level-editor="true"');
    expect(html).toContain('data-model-input-modality="text"');
    expect(html).toContain('data-model-input-modality="image"');
    expect(html).toContain('data-model-input-modality="video"');
    expect(html).toContain('data-model-input-modality="pdf"');
    expect(html).not.toContain('data-model-input-modality="audio"');
    expect(html).not.toContain('data-model-output-modality="text"');
    expect(html).not.toContain('data-model-modality-icon="true"');
    expect(html.match(/data-model-modality-lock="true"/g)).toHaveLength(1);
    const modalityButtons =
      html.match(/<button[^>]*data-model-(?:input|output)-modality=[^>]*>/g) ?? [];
    expect(modalityButtons).toHaveLength(4);
    for (const button of modalityButtons) {
      expect(button).toContain('data-variant="outline"');
      expect(button).toContain('data-size="lg"');
      expect(button).toContain("px-3");
    }
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="image"')),
    ).toContain('aria-pressed="false"');
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain('aria-pressed="true"');
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain("bg-foreground/15");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain("border-border");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain("bg-clip-border");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain("hover:bg-foreground/20");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="image"')),
    ).toContain("bg-transparent");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="image"')),
    ).toContain("hover:bg-hover");
    expect(
      modalityButtons.find((button) => button.includes('data-model-input-modality="text"')),
    ).toContain('disabled=""');
    expect(html.match(/lucide-lock-keyhole/g)).toHaveLength(1);
    expect(html).not.toContain("border-brand");
    expect(html).not.toContain("bg-brand/10");
    expect(html).toContain('value="1000000"');
    expect(html).not.toContain("settings.modelProvider.reasoningLevelOptionSpecJson");
    expect(html).toContain('data-model-settings-footer="true"');
    expect(html).toContain(">取消<");
    expect(html).toContain(">保存<");
    const saveButton = extractButtonOpeningTag(html, "保存");
    const cancelButton = extractButtonOpeningTag(html, "取消");
    expect(saveButton).toContain('data-variant="default"');
    expect(saveButton).toContain('data-size="lg"');
    expect(cancelButton).toContain('data-variant="ghost"');
    expect(cancelButton).toContain('data-size="lg"');
    expect(html.lastIndexOf(">取消<")).toBeLessThan(html.lastIndexOf(">保存<"));
    expect(html.match(/添加模型/g)).toHaveLength(1);
  });

  it("解析模型配置时展示 loading，并允许保存按钮主动等待当前解析", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        modelConfigResolutionPending: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "glm-5",
          nameValue: "",
          kindsValue: ["anthropic"],
          contextWindowValue: "1000000",
          maxOutputTokensValue: "128000",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain("加载中...");
    expect(html).toContain("animate-spin");
    expect(extractInputTag(html, 'aria-label="最大输出 Token"')).not.toMatch(
      /\sdisabled(?:=|\s|\/|>)/,
    );
    expect(extractButtonOpeningTag(html, "保存")).not.toContain(' disabled=""');
  });

  it("添加模型弹窗默认聚焦模型 ID，不自动聚焦上下文窗口", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "",
          nameValue: "",
          kindsValue: ["anthropic"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const modelIdInput = extractInputTag(html, 'placeholder="模型 ID"');
    const contextWindowInput = extractInputTag(html, 'inputMode="numeric"');

    expect(modelIdInput).toContain('autofocus=""');
    expect(contextWindowInput).not.toContain("autofocus");
  });

  it("编辑模型弹窗 footer 展示取消和保存", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "deepseek-v4-flash",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain("编辑模型配置");
    expect(html).toContain('data-model-settings-footer="true"');
    expect(html).toContain(">取消<");
    expect(html).toContain(">保存<");
  });

  it("模型弹窗不展示 API 格式选项", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        apiFormatOptions: ["anthropic-messages"],
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "",
          nameValue: "",
          kindsValue: ["anthropic", "openai-compatible", "openai"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).not.toContain("API 格式");
    expect(html).not.toContain('data-api-format-selected-tag="anthropic"');
    expect(html).not.toContain('data-api-format-option="anthropic"');
    expect(html).not.toContain(">/anthropic/v1/messages<");
    expect(html).not.toContain(">/v1/chat/completions<");
    expect(html).not.toContain("Responses (/responses)");
  });

  it("模型弹窗忽略供应商 API 格式 path 配置", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        apiFormatOptions: ["openai-chat-completions"],
        endpointPaths: {
          "openai-compatible": "/custom/chat",
        },
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).not.toContain("API 格式");
    expect(html).not.toContain(">/custom/chat<");
    expect(html).not.toContain(">/v1/chat/completions<");
  });

  it("模型弹窗不展示 API 格式多选触发器和弹层选项", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        draft: {
          ...MODEL_FORMAT_DRAFT,
          idValue: "",
          nameValue: "",
          kindsValue: ["anthropic", "openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).not.toContain('data-api-format-selected-tag="anthropic"');
    expect(html).not.toContain('data-api-format-selected-tag="openai-compatible"');
    expect(html).not.toContain(">Anthropic<");
    expect(html).not.toContain(">Chat<");
    expect(html).not.toContain('data-api-format-option="anthropic"');
    expect(html).not.toContain(
      "Anthropic Messages (/anthropic/v1/messages), Chat Completions (/v1/chat/completions)",
    );
  });
});
