import { describe, expect, it } from "vitest";
import {
  buildCustomSupplierKey,
  buildGhostSupplierKey,
  buildNativeSupplierKey,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  isCustomSupplierKeyForProvider,
  parseCustomProviderIdFromSupplierKey,
  resolveModelNameForConfigSync,
  resolveWorkspaceModelConfigSyncScope,
  type ModelConfigSyncWorkspaceSnapshot,
} from "../src/lib/modelConfigSync.js";

function createModelOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "glm-4.7", name: "glm-4.7" },
      { value: "glm-4.7-flash", name: "glm-4.7-flash" },
    ],
  };
}

function createWorkspaceSnapshot(
  overrides: Partial<ModelConfigSyncWorkspaceSnapshot> = {},
): ModelConfigSyncWorkspaceSnapshot {
  return {
    activeTaskId: null,
    selectedProvider: "claude",
    selectedSupplierKey: buildNativeSupplierKey("claude"),
    configOptions: [createModelOption("glm-4.7")],
    optimisticTaskListByTaskId: {},
    taskListCache: null,
    ...overrides,
  };
}

describe("model config sync helpers", () => {
  it("能识别 custom supplier key 并提取 providerId", () => {
    expect(isCustomSupplierKeyForProvider("custom:provider-a", "provider-a")).toBe(true);
    expect(parseCustomProviderIdFromSupplierKey("custom:provider-a")).toBe("provider-a");
    expect(parseCustomProviderIdFromSupplierKey("native:glm")).toBeNull();
  });

  it("能从 ghost supplier key 中提取 custom providerId", () => {
    const ghostSupplierKey = buildGhostSupplierKey(
      "claude",
      "no-preference",
      "provider=default-mimo,baseurl=https://token-plan-cn.xiaomimimo.com/anthropic",
    );

    expect(parseCustomProviderIdFromSupplierKey(ghostSupplierKey)).toBe("default-mimo");
    expect(isCustomSupplierKeyForProvider(ghostSupplierKey, "default-mimo")).toBe(true);
  });

  it("会优先保留当前 custom 模型", () => {
    const modelName = resolveModelNameForConfigSync({
      configOptions: [createModelOption("custom:provider-a:glm-4.7")],
      selectedProvider: "claude",
      providerId: "provider-a",
      providerModels: ["glm-4.7", "glm-4.7-flash"],
    });

    expect(modelName).toBe("glm-4.7");
  });

  it("activeTask 存在时，session action scope 会优先使用 task provider + task 模型 supplier", () => {
    const scope = resolveWorkspaceModelConfigSyncScope(
      createWorkspaceSnapshot({
        activeTaskId: "task-1",
        selectedProvider: "codex",
        selectedSupplierKey: buildNativeSupplierKey("codex"),
        configOptions: [createModelOption("custom:provider-a:glm-4.7")],
        optimisticTaskListByTaskId: {
          "task-1": {
            provider: "claude",
          },
        },
      }),
    );

    expect(scope).toEqual({
      provider: "claude",
      supplierKey: buildCustomSupplierKey("provider-a"),
    });
  });

  it("activeTask 模型回包为纯模型名时，仍沿用当前 custom supplier scope", () => {
    const scope = resolveWorkspaceModelConfigSyncScope(
      createWorkspaceSnapshot({
        activeTaskId: "task-1",
        selectedProvider: "claude",
        selectedSupplierKey: buildCustomSupplierKey("provider-a"),
        configOptions: [createModelOption("glm-4.7")],
        optimisticTaskListByTaskId: {
          "task-1": {
            provider: "claude",
          },
        },
      }),
    );

    expect(scope).toEqual({
      provider: "claude",
      supplierKey: buildCustomSupplierKey("provider-a"),
    });
  });

  it("activeTask 的 optimistic provider 会覆盖旧 taskListCache", () => {
    const scope = resolveWorkspaceModelConfigSyncScope(
      createWorkspaceSnapshot({
        activeTaskId: "task-1",
        selectedProvider: "claude",
        selectedSupplierKey: buildNativeSupplierKey("claude"),
        configOptions: [createModelOption("glm-4.7")],
        taskListCache: [
          {
            taskId: "task-1",
            provider: "claude",
          },
        ],
        optimisticTaskListByTaskId: {
          "task-1": {
            provider: "codex",
          },
        },
      }),
    );

    expect(scope).toEqual({
      provider: "codex",
      supplierKey: buildNativeSupplierKey("codex"),
    });
  });

  it("activeTask provider 与 selectedProvider 不一致且缺少模型选项时，回退到 active provider 原生 supplier", () => {
    const scope = resolveWorkspaceModelConfigSyncScope(
      createWorkspaceSnapshot({
        activeTaskId: "task-1",
        selectedProvider: "codex",
        selectedSupplierKey: buildCustomSupplierKey("provider-a"),
        configOptions: null,
        optimisticTaskListByTaskId: {
          "task-1": {
            provider: "claude",
          },
        },
      }),
    );

    expect(scope).toEqual({
      provider: "claude",
      supplierKey: buildNativeSupplierKey("claude"),
    });
  });

});
