import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * 覆盖按 taskType 解析的重试预算，只绑定到本次创建的句柄，不进入 Factory 输入。
     * 目前只有带 selectionFallback 声明的执行作用域 Selection 使用 single-attempt。
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  return withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const layer: ModelInvocationContext = {
    // 原因：标题、Memory、工具调用曾按用途覆写 other，丢失宿主分类。
    // 会话类型统一绑定在句柄上；工作区独立请求即使借用会话 runtime 也保持 other。
    modelRequestSessionType: sessionType,
    // 带退回声明的执行句柄显式传入 single-attempt，其余沿用 taskType 默认预算。
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
