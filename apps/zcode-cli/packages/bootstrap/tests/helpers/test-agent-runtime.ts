// ============================================================
// bootstrap 测试的 Model / AgentRuntime 夹具（照 core/tests 的同名夹具）
// ============================================================
// provider 重构后 AgentRuntime 只经 ModelFactory/ModelSelection 造 Model，没有「直接注入
// adapter」的兼容路径。dwf 的 driver / run service 测试仍以脚本化 adapter 表达 actor 的应答，
// 这里把它包成测试 ModelFactory，并给 runtime 一个缺省的 selection——与 core 的夹具同形，
// bootstrap 不能跨包引用 core 的 tests/ 目录，所以复制一份。

import {
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  type Model,
  type ModelEvent,
  type ModelInputFormat,
  type ModelInvocationContext,
  type ModelOptions,
  type ModelProperties,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
} from "@zcode/contracts";
import { AgentRuntime, type AgentRuntimeConfig, type AgentRuntimeDeps } from "@zcode/core";

type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;
type RuntimeModelFactoryInput = Parameters<RuntimeModelFactory>[0];

export function createTestInputFormat(override: Partial<ModelInputFormat> = {}): ModelInputFormat {
  return {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: true,
    ...override,
  };
}

export function createTestModelFormatProperties(inputFormat: Partial<ModelInputFormat> = {}) {
  return {
    inputFormat: createTestInputFormat(inputFormat),
    outputFormat: { supportsText: true as const },
  };
}

export function createTestRuntimeModel(input: {
  contextWindow?: number;
  generateText: (request: ModelRequest) => Promise<ModelResult>;
  inputFormat?: Partial<ModelInputFormat>;
  maxOutputTokens?: number;
  modelId?: string;
  providerId?: string;
  properties?: ModelProperties;
  propertyOverrides?: Partial<ModelProperties>;
  options?: ModelOptions;
}): Model {
  const maxOutputTokens = input.maxOutputTokens ?? 32_000;
  const options = {
    maxOutputTokens,
    reasoningLevel: "disabled",
    ...input.options,
  };
  const model: Model = {
    providerId: createModelProviderId(input.providerId ?? "test"),
    modelId: createModelId(input.modelId ?? "model"),
    properties:
      input.properties ??
      ({
        contextWindow: input.contextWindow ?? 200_000,
        ...createTestModelFormatProperties(input.inputFormat),
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
        ...input.propertyOverrides,
      } satisfies ModelProperties),
    optionSpecs: {
      reasoningLevel: { values: ["disabled"] },
      maxOutputTokens: { max: maxOutputTokens },
    },
    options,
    bind(nextOptions) {
      return createTestRuntimeModel({ ...input, options: { ...options, ...nextOptions } });
    },
    generateText: input.generateText,
    async *streamText(request) {
      const result = await input.generateText(request);
      if (result.text) {
        yield { id: "test-text", type: "text_start" };
        yield { id: "test-text", type: "text_delta", text: result.text };
        yield { id: "test-text", type: "text_end" };
      }
      yield {
        type: "finish",
        finishReason: result.finishReason,
        usage: result.usage,
      };
    },
  };
  return model;
}

export interface TestModelExecutionObservation {
  factoryInput: RuntimeModelFactoryInput;
  invocationContext: ModelInvocationContext | undefined;
  model: Pick<Model, "providerId" | "modelId" | "options">;
}

export function createTestModelFactory(implementation: {
  generateText?: (
    request: ModelRequest,
    observation: TestModelExecutionObservation,
  ) => Promise<ModelResult>;
  onCreate?: (input: RuntimeModelFactoryInput) => void;
  maxOutputTokens?: number | ((input: RuntimeModelFactoryInput) => number);
  properties?: Partial<ModelProperties>;
  reasoningLevels?: readonly string[] | null;
  streamText?: (
    request: ModelRequest,
    observation: TestModelExecutionObservation,
  ) => AsyncIterable<ModelEvent>;
}): RuntimeModelFactory {
  return (input) => {
    implementation.onCreate?.(input);
    const observe = (options: ModelOptions): TestModelExecutionObservation => ({
      factoryInput: input,
      invocationContext: getCurrentModelInvocationContext(),
      model: {
        providerId: createModelProviderId(input.selection.providerId),
        modelId: createModelId(input.selection.modelId),
        options,
      },
    });
    const maxOutputTokens =
      typeof implementation.maxOutputTokens === "function"
        ? implementation.maxOutputTokens(input)
        : (implementation.maxOutputTokens ?? 32_000);
    const createModel = (options: ModelOptions): Model => {
      const generateText =
        implementation.generateText === undefined
          ? async () => {
              throw new Error("测试 Model 未实现 generateText");
            }
          : (request: ModelRequest) => implementation.generateText!(request, observe(options));
      const model = createTestRuntimeModel({
        generateText,
        maxOutputTokens,
        modelId: input.selection.modelId,
        options,
        propertyOverrides: {
          supportsMidConversationSystem: false,
          ...implementation.properties,
        },
        providerId: input.selection.providerId,
      });
      const reasoningLevels =
        implementation.reasoningLevels === null
          ? (["disabled"] as const)
          : (implementation.reasoningLevels ?? (["low", "high"] as const));
      return Object.freeze({
        ...model,
        optionSpecs: Object.freeze({
          ...model.optionSpecs,
          reasoningLevel: Object.freeze({
            values: Object.freeze([...reasoningLevels]),
          }),
        }),
        bind(nextOptions) {
          return createModel({ ...options, ...nextOptions });
        },
        ...(implementation.streamText
          ? {
              streamText: (request: ModelRequest) =>
                implementation.streamText!(request, observe(options)),
            }
          : {}),
      });
    };
    return createModel({
      ...input.selection.options,
      reasoningLevel:
        input.selection.options?.reasoningLevel ??
        (implementation.reasoningLevels === null
          ? ["disabled"]
          : (implementation.reasoningLevels ?? ["low", "high"])
        ).at(-1)!,
    });
  };
}

type TestModelAdapter = {
  generateText: (request: ModelRequest) => Promise<ModelResult>;
  streamText?: (request: ModelRequest) => AsyncIterable<ModelEvent>;
};

type TestRuntimeConfig = Omit<AgentRuntimeConfig, "modelSelection"> &
  Partial<Pick<AgentRuntimeConfig, "modelSelection">>;
type TestRuntimeDeps = Omit<AgentRuntimeDeps, "modelFactory"> &
  Partial<Pick<AgentRuntimeDeps, "modelFactory">> & {
    /** 脚本化 adapter：包成测试 ModelFactory；给了 modelFactory 时忽略。 */
    modelAdapter?: TestModelAdapter;
  };

export function createTestModelSelection(
  input: string | ModelSelection,
  options?: ModelSelection["options"],
): ModelSelection {
  if (typeof input !== "string") {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.options ? { options: { ...input.options } } : {}),
    };
  }
  const separator = input.indexOf("/");
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error(`Test model selection must be provider-qualified: ${input}`);
  }
  return {
    providerId: input.slice(0, separator),
    modelId: input.slice(separator + 1),
    ...(options ? { options: { ...options } } : {}),
  };
}

/** 把脚本化 adapter 包成测试 ModelFactory（与 createTestAgentRuntime 同一条换算）。 */
export function createTestModelFactoryFromAdapter(modelAdapter: TestModelAdapter): RuntimeModelFactory {
  return createTestModelFactory({
    generateText: (request) => modelAdapter.generateText(request),
    ...(modelAdapter.streamText
      ? { streamText: (request) => modelAdapter.streamText!(request) }
      : {}),
  });
}

/**
 * 低层 Runtime 测试也显式经过 ModelFactory/ModelSelection 契约：
 * 缺省 selection 为 `test/default-runtime-model`，缺省 Model 不联网。
 */
export function createTestAgentRuntime(
  sessionId: ConstructorParameters<typeof AgentRuntime>[0],
  config: TestRuntimeConfig,
  deps: TestRuntimeDeps,
): AgentRuntime {
  const modelSelection =
    config.modelSelection ?? createTestModelSelection("test/default-runtime-model");
  const { modelAdapter, ...runtimeDeps } = deps;
  const modelFactory =
    deps.modelFactory ??
    (modelAdapter ? createTestModelFactoryFromAdapter(modelAdapter) : createTestModelFactory({}));
  return new AgentRuntime(sessionId, { ...config, modelSelection }, { ...runtimeDeps, modelFactory });
}
