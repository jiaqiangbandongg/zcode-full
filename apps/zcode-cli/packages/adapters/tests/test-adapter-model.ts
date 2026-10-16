import {
  runWithModelInvocationContext,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResult,
  type ModelProperties,
  type ModelStreamEvent,
  type ModelTextRequest,
} from "@zcode/contracts";
import type { TestAiSdkModelAdapter } from "./test-provider-config.js";
import { createTestModelProperties } from "./test-model-format.js";
import type { ZhipuAccountMode } from "@zcode/provider";

type TestModelTextRequest = ModelTextRequest & {
  properties?: ModelProperties;
  accountMode?: ZhipuAccountMode;
};

export function executeAdapterGenerateText(
  adapter: TestAiSdkModelAdapter,
  request: TestModelTextRequest,
): Promise<ModelResult> {
  const model = createAdapterTestModel(adapter, request);
  return runWithModelInvocationContext(invocationContext(request), () =>
    model.generateText(modelRequest(request)),
  );
}

export function executeAdapterStreamText(
  adapter: TestAiSdkModelAdapter,
  request: TestModelTextRequest,
): AsyncIterable<ModelStreamEvent> {
  const model = createAdapterTestModel(adapter, request);
  return runWithModelInvocationContext(invocationContext(request), () =>
    model.streamText(modelRequest(request)),
  );
}

function createAdapterTestModel(adapter: TestAiSdkModelAdapter, request: TestModelTextRequest) {
  const maxOutputTokens = request.maxOutputTokens ?? 32_000;
  return adapter.createModel({
    ...(request.accountMode || request.refreshRuntimeHeadersBeforeAttempt
      ? {
          accountMode: request.accountMode ?? ("individual-coding-plan" as const),
        }
      : {}),
    providerId: request.providerId,
    modelId: request.modelId,
    properties: request.properties ?? createTestModelProperties(),
    optionSpecs: {
      maxOutputTokens: {
        max: Math.max(maxOutputTokens, 1_000_000),
      },
    },
    options: { maxOutputTokens },
  });
}

function modelRequest(request: ModelTextRequest): ModelRequest {
  return {
    abortSignal: request.abortSignal,
    messages: request.messages,
    tools: request.tools,
    ...(request.responseJsonSchema ? { responseJsonSchema: request.responseJsonSchema } : {}),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { options: { maxOutputTokens: request.maxOutputTokens } }),
  };
}

function invocationContext(request: ModelTextRequest): ModelInvocationContext {
  return {
    metadata: request.metadata,
    modelCall: request.modelCall,
    // 准入端口与重试预算（docs/dynamic-workflow/concurrency.md「Where the port is bound」）同样经调用上下文到 runner。
    modelRequestAdmission: request.modelRequestAdmission,
    modelRetryBudget: request.modelRetryBudget,
    modelRequestSessionType: request.modelRequestSessionType,
    preserveProviderStreamBoundaries: request.preserveProviderStreamBoundaries,
    refreshRuntimeHeadersBeforeAttempt: request.refreshRuntimeHeadersBeforeAttempt,
    statusSink: request.statusSink,
    streamIdleTimeoutRetryNumber: request.streamIdleTimeoutRetryNumber,
    streamRecovery: request.streamRecovery,
    traceContext: request.traceContext,
  };
}
