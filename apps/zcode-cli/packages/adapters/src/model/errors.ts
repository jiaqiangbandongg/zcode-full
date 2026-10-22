// ============================================================
// AI SDK model adapter errors
// ============================================================

import {
  ModelFailureReason,
  type ErrorAttribution,
  type ModelErrorCode,
  type ModelId,
  type ModelUsage,
} from "@zcode/contracts";

export const ModelErrorSource = {
  Network: "network",
  Provider: "provider",
  Runtime: "runtime",
} as const satisfies Record<string, NonNullable<ErrorAttribution["source"]>>;

export type ModelErrorSource = (typeof ModelErrorSource)[keyof typeof ModelErrorSource];

export type LocalProviderConfigurationErrorContext = Record<string, unknown> & {
  envKey?: string;
  modelId?: ModelId;
  providerId: string;
  reason: typeof ModelFailureReason.ProviderNotConfigured;
  retryable: false;
  source: typeof ModelErrorSource.Runtime;
};

export function createLocalProviderConfigurationErrorContext(
  context: Pick<LocalProviderConfigurationErrorContext, "envKey" | "modelId" | "providerId">,
): LocalProviderConfigurationErrorContext {
  // provider 缺失和鉴权配置错误发生在请求创建前，不会经过 runner 的错误归一化；
  // 必须在 Model Execution 装配边界直接保留 runtime 归因，避免监控把本地配置问题记到上游 provider。
  return {
    ...context,
    reason: ModelFailureReason.ProviderNotConfigured,
    retryable: false,
    source: ModelErrorSource.Runtime,
  };
}

export interface AiSdkModelAdapterErrorOptions {
  cause?: unknown;
  context?: Record<string, unknown>;
  usage?: ModelUsage;
}

export class AiSdkModelAdapterError extends Error {
  readonly code: ModelErrorCode;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
  readonly usage?: ModelUsage;

  constructor(code: ModelErrorCode, message: string, options?: AiSdkModelAdapterErrorOptions) {
    super(message);
    this.name = "AiSdkModelAdapterError";
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;
    this.usage = options?.usage;
  }

  enrichContext(context: Record<string, unknown>): this {
    Object.assign(this, { context });
    return this;
  }
}
