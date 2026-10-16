import type { TaskStoreSnapshot } from "./conversation-session-store.js";

type BrowserConfigOption = {
  category?: string;
  currentValue?: unknown;
  id?: string;
  options?: Array<{ value?: string }>;
  type?: string;
};

type BrowserTaskMeta = {
  model?: string | null;
  provider?: string | null;
  target?: {
    objective?: string | null;
    status?: string | null;
    targetID?: string | null;
  } | null;
  taskId: string;
  title?: string | null;
};

type BrowserTaskMessage = {
  id?: string;
  role?: string;
  streaming?: boolean;
  syntheticTimeline?: {
    goalIteration?: number;
    inputId?: string;
    operationId?: string;
    status?: string;
    targetId?: string;
    type?: string;
    verification?: {
      passed?: boolean | null;
    } | null;
  };
  type?: string;
};

type BrowserWorkspaceState = {
  activeTaskId?: string | null;
  configOptions?: BrowserConfigOption[] | null;
  optimisticTaskListByTaskId?: Record<string, BrowserTaskMeta>;
  queuedPromptsByTaskId?: Record<string, { content?: string }[]>;
  selectedProvider?: string | null;
  selectedSupplierKey?: string | null;
  taskConfigOptionsByTaskId?: Record<string, BrowserConfigOption[]>;
  taskListCache?: BrowserTaskMeta[] | null;
  taskMessagesByTaskId?: Record<string, BrowserTaskMessage[]>;
  taskRuntimeByTaskId?: Record<
    string,
    {
      activeInputId?: string | null;
      error?: string | null;
      status?: string | null;
    }
  >;
  taskStopRequestedByTaskId?: Record<string, boolean>;
  taskUiByTaskId?: Record<
    string,
    {
      error?: unknown;
      permissionRequest?: unknown | null;
      pendingPermissionRequests?: unknown[];
    }
  >;
};

export function readTaskStoreSnapshotInBrowser(
  taskIdArg: string,
  workspaceKeyArg?: string,
): {
  snapshot: TaskStoreSnapshot;
} {
  const selectConfigSummary = (options: BrowserConfigOption[] | null | undefined) =>
    (options ?? [])
      .filter((option) =>
        ["model", "mode", "thought_level"].includes(option.category ?? option.id ?? ""),
      )
      .map((option) => ({
        category: option.category ?? null,
        currentValue:
          typeof option.currentValue === "string"
            ? option.currentValue
            : option.currentValue == null
              ? null
              : String(option.currentValue),
        id: option.id ?? null,
        optionValues: (option.options ?? []).map((candidate) => candidate.value ?? ""),
        type: option.type ?? null,
      }));
  const readLastSelectedModelStorage = () => {
    const result: Record<string, string | null> = {};
    try {
      for (const [key, value] of Object.entries(window.localStorage)) {
        if (key.startsWith("zcode-model-selection-recent-v1:")) {
          result[key] = value;
        }
      }
    } catch {
      result["<localStorage-error>"] = null;
    }
    return result;
  };
  const stringifyUiError = (error: unknown) => {
    if (!error) {
      return null;
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error === "object") {
      const record = error as {
        code?: unknown;
        detail?: unknown;
        message?: unknown;
        traceId?: unknown;
      };
      return JSON.stringify({
        code: record.code ?? null,
        detail: record.detail ?? null,
        message: record.message ?? null,
        traceId: record.traceId ?? null,
      });
    }
    return String(error);
  };
  const bridge = (
    window as typeof window & {
      __zcodeSessionStoreE2E?: {
        getState?: () => {
          workspaces?: Record<string, BrowserWorkspaceState>;
        };
      };
    }
  ).__zcodeSessionStoreE2E;
  const bridgeMissing = typeof bridge?.getState !== "function";
  const state = bridge?.getState?.();
  const workspaces = state?.workspaces ?? {};
  const knownWorkspaceKeys = Object.keys(workspaces);
  const workspaceContainsTask = (workspace: BrowserWorkspaceState) => {
    const queue = workspace.queuedPromptsByTaskId?.[taskIdArg];
    const runtime = workspace.taskRuntimeByTaskId?.[taskIdArg];
    const messages = workspace.taskMessagesByTaskId?.[taskIdArg];
    const ui = workspace.taskUiByTaskId?.[taskIdArg];
    const optimisticMeta = workspace.optimisticTaskListByTaskId?.[taskIdArg];
    const cachedMeta = workspace.taskListCache?.some?.((task) => task.taskId === taskIdArg);
    const hasStopState = Object.prototype.hasOwnProperty.call(
      workspace.taskStopRequestedByTaskId ?? {},
      taskIdArg,
    );
    return Boolean(
      workspace.activeTaskId === taskIdArg ||
      queue ||
      runtime ||
      messages ||
      ui ||
      optimisticMeta ||
      cachedMeta ||
      hasStopState,
    );
  };
  const workspaceEntry = workspaceKeyArg
    ? workspaces[workspaceKeyArg] && workspaceContainsTask(workspaces[workspaceKeyArg])
      ? ([workspaceKeyArg, workspaces[workspaceKeyArg]] as const)
      : null
    : (Object.entries(workspaces).find(([, workspace]) => workspaceContainsTask(workspace)) ??
      null);

  if (bridgeMissing || !workspaceEntry) {
    return {
      snapshot: {
        activeInputId: null,
        activeTaskConfigOptions: [],
        activeTaskId: null,
        // 修复原因：CI 若误用 production 构建，renderer 不会暴露测试 store bridge。
        // 单独标记 bridge 缺失，避免把环境问题误判成 task store hydrate 慢。
        error: bridgeMissing ? "session-store-bridge-missing" : "task-not-found-in-store",
        hasPendingPermission: false,
        knownWorkspaceKeys,
        lastSelectedModelStorage: readLastSelectedModelStorage(),
        messageCount: 0,
        queueCount: 0,
        queuedTexts: [],
        runtimeStatus: null,
        selectedProvider: null,
        selectedSupplierKey: null,
        stopRequested: false,
        streamingAssistantCount: 0,
        taskConfigOptions: [],
        taskId: taskIdArg,
        taskMeta: null,
        timelineSummaries: [],
        uiError: null,
        workspaceConfigOptions: [],
        workspaceKey: null,
      },
    };
  }

  const [workspaceKey, workspace] = workspaceEntry;
  const activeTaskId = workspace.activeTaskId ?? null;
  const runtime = workspace.taskRuntimeByTaskId?.[taskIdArg];
  const queuedPrompts = workspace.queuedPromptsByTaskId?.[taskIdArg] ?? [];
  const messages = workspace.taskMessagesByTaskId?.[taskIdArg] ?? [];
  const taskUi = workspace.taskUiByTaskId?.[taskIdArg];
  const pendingPermissionCount = taskUi?.pendingPermissionRequests?.length ?? 0;
  const taskMeta =
    workspace.optimisticTaskListByTaskId?.[taskIdArg] ??
    workspace.taskListCache?.find?.((task) => task.taskId === taskIdArg) ??
    null;

  return {
    snapshot: {
      activeInputId: runtime?.activeInputId ?? null,
      activeTaskConfigOptions: selectConfigSummary(
        activeTaskId ? workspace.taskConfigOptionsByTaskId?.[activeTaskId] : null,
      ),
      activeTaskId,
      error: runtime?.error ?? null,
      hasPendingPermission: taskUi?.permissionRequest != null || pendingPermissionCount > 0,
      knownWorkspaceKeys,
      lastSelectedModelStorage: readLastSelectedModelStorage(),
      messageCount: messages.length,
      queueCount: queuedPrompts.length,
      queuedTexts: queuedPrompts.map((prompt) => prompt.content ?? ""),
      runtimeStatus: runtime?.status ?? null,
      selectedProvider: workspace.selectedProvider ?? null,
      selectedSupplierKey: workspace.selectedSupplierKey ?? null,
      stopRequested: workspace.taskStopRequestedByTaskId?.[taskIdArg] === true,
      streamingAssistantCount: messages.filter(
        (message) => message.role === "assistant" && message.streaming === true,
      ).length,
      taskConfigOptions: selectConfigSummary(workspace.taskConfigOptionsByTaskId?.[taskIdArg]),
      taskId: taskIdArg,
      taskMeta: taskMeta
        ? {
            model: taskMeta.model ?? null,
            provider: taskMeta.provider ?? null,
            targetId: taskMeta.target?.targetID ?? null,
            targetObjective: taskMeta.target?.objective ?? null,
            targetStatus: taskMeta.target?.status ?? null,
            title: taskMeta.title ?? null,
          }
        : null,
      timelineSummaries: messages
        .filter((message) => message.syntheticTimeline)
        .map((message) => ({
          goalIteration:
            typeof message.syntheticTimeline?.goalIteration === "number"
              ? message.syntheticTimeline.goalIteration
              : null,
          id: message.id ?? null,
          inputId: message.syntheticTimeline?.inputId ?? null,
          operationId: message.syntheticTimeline?.operationId ?? null,
          status: message.syntheticTimeline?.status ?? null,
          targetId: message.syntheticTimeline?.targetId ?? null,
          type: message.syntheticTimeline?.type ?? null,
          verificationPassed:
            typeof message.syntheticTimeline?.verification?.passed === "boolean"
              ? message.syntheticTimeline.verification.passed
              : null,
        })),
      uiError: stringifyUiError(taskUi?.error),
      workspaceConfigOptions: selectConfigSummary(workspace.configOptions),
      workspaceKey,
    },
  };
}
