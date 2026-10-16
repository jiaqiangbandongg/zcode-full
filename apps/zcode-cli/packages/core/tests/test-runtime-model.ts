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
} from "@zcode/contracts";
import type { RuntimeModelFactory, RuntimeModelFactoryInput } from "../src/runtime/types.js";

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
