import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  type ZCodeError,
  type ZCodeConfigOption,
  type ZCodePermissionRequest,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import {
  DEFAULT_TASK_UI_STATE,
  DEFAULT_TASK_RUNTIME_STATE,
  getTaskRuntimeState,
  getTaskUnreadIndicator,
  getTaskUiState,
  getWorkspaceDisplayedTaskState,
  useZCodeSessionStore,
} from "../src/store/zcodeSessionStore.js";
import { canGoForward } from "../src/lib/taskNavigationHistory.js";
import { LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY } from "../src/lib/zcodeProviderPreference.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));

  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "修复任务删除联动",
    workspacePath: "/tmp/workspace-delete",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function createPermissionRequest(
  overrides: Partial<ZCodePermissionRequest> = {},
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-1",
    description: "允许执行命令",
    kind: "execute",
    options: [
      {
        optionId: "allow-once",
        kind: "allow_once",
        name: "允许一次",
      },
    ],
    raw: { toolCallId: "tool-1" },
    ...overrides,
  };
}

function createZCodeError(overrides: Partial<ZCodeError> = {}): ZCodeError {
  return {
    code: "SEND_FAILED",
    message: "命令执行失败",
    traceId: "trace-error-1",
    taskId: "task-1",
    ...overrides,
  };
}

function createComposerDraft(
  overrides: Pick<ComposerDraftState, "text"> & Partial<ComposerDraftState>,
): ComposerDraftState {
  return {
    attachments: [],
    codeCommentAttachments: [],
    webElementContexts: [],
    ...overrides,
  };
}

function createModelConfigOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  };
}

function createModeConfigOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
      { value: "yolo", name: "Yolo" },
    ],
  };
}

function createThoughtConfigOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    currentValue,
    options: [
      { value: "max", name: "Max" },
      { value: "high", name: "High" },
      { value: "nothink", name: "No Think" },
    ],
  };
}

function readModelConfigValue(
  options: readonly ZCodeConfigOption[] | null | undefined,
): string | null {
  const modelOption = options?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  return typeof modelOption?.currentValue === "string" ? modelOption.currentValue : null;
}

function readModeConfigOption(options: readonly ZCodeConfigOption[] | null | undefined) {
  return options?.find((option) => option.category === "mode" && option.type === "select") ?? null;
}

describe("useZCodeSessionStore provider preference", () => {
  beforeEach(() => {
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("新 workspace 会把旧 provider 偏好归一为 glm", () => {
    const storage = createStorageMock({
      [LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY]: "codex",
    });
    vi.stubGlobal("window", { localStorage: storage });

    const workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState("/tmp/workspace-codex");

    expect(workspaceState.selectedProvider).toBe("glm");
  });

  it("setConfigOptions 会把空 thought_level 归一到第一个合法选项", () => {
    const workspacePath = "/tmp/workspace-thought-normalize";
    useZCodeSessionStore.getState().setConfigOptions(workspacePath, [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
        ],
      },
    ]);

    expect(
      useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath)
        .configOptions?.find((option) => option.id === "thought_level")?.currentValue,
    ).toBe("low");
  });

  it.each([
    [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, "glm-5.2-pro"],
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan, "GLM-5.2"],
    ["default-glm", "glm-0606[1m]"],
  ])("setConfigOptions 保留 %s/%s 的 high 思考强度", (providerId, modelId) => {
    const workspacePath = `/tmp/workspace-hide-high-${providerId}-${modelId}`;
    useZCodeSessionStore.getState().setConfigOptions(workspacePath, [
      createModelConfigOption(`${providerId}/${modelId}`),
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "max", name: "Max" },
          { value: "high", name: "High" },
          { value: "nothink", name: "No Thinking" },
        ],
      },
    ]);

    const thoughtOption = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath)
      .configOptions?.find((option) => option.id === "thought_level");

    expect(thoughtOption?.options?.map((option) => option.value)).toEqual([
      "max",
      "high",
      "nothink",
    ]);
    expect(thoughtOption?.currentValue).toBe("high");
  });

  it("setConfigOptions 保留无 provider 的 glm-date 模型 high 思考强度", () => {
    const workspacePath = "/tmp/workspace-hide-high-plain-glm-date";
    useZCodeSessionStore.getState().setConfigOptions(workspacePath, [
      createModelConfigOption("glm-0606[1m]"),
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "max", name: "Max" },
          { value: "high", name: "High" },
          { value: "nothink", name: "No Thinking" },
        ],
      },
    ]);

    const thoughtOption = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath)
      .configOptions?.find((option) => option.id === "thought_level");

    expect(thoughtOption?.options?.map((option) => option.value)).toEqual([
      "max",
      "high",
      "nothink",
    ]);
    expect(thoughtOption?.currentValue).toBe("high");
  });

  it("bindRuntimeProvider 会归一旧 provider，不覆盖 supplier 且不改本地偏好", () => {
    const storage = createStorageMock();
    vi.stubGlobal("window", { localStorage: storage });
    const workspacePath = "/tmp/workspace-runtime-bind";
    const customSupplierKey = buildCustomSupplierKey("provider-a");

    useZCodeSessionStore.getState().startDraft(workspacePath, "codex");
    useZCodeSessionStore.getState().setModelSelectionResolution(workspacePath, {
      selectedSupplierKey: customSupplierKey,
      isGhostSupplier: false,
      supplierMismatchReason: null,
    });

    useZCodeSessionStore.getState().bindRuntimeProvider(workspacePath, "opencode");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(storage.getItem(LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY)).toBe("glm");
    expect(workspaceState.selectedProvider).toBe("glm");
    expect(workspaceState.selectedSupplierKey).toBe(customSupplierKey);
  });

  it("同路径不同 workspaceIdentity 输入旧 provider 时都应归一为 glm", () => {
    const workspacePath = "/tmp/workspace-identity-isolation";
    const workspaceIdentityA = "ssh://user@host-a:/tmp/workspace-identity-isolation";
    const workspaceIdentityB = "ssh://user@host-b:/tmp/workspace-identity-isolation";

    useZCodeSessionStore.getState().startDraft(workspacePath, "claude", workspaceIdentityA);
    useZCodeSessionStore.getState().startDraft(workspacePath, "opencode", workspaceIdentityB);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .selectedProvider,
    ).toBe("glm");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityB)
        .selectedProvider,
    ).toBe("glm");
  });

  it("composer 文本插入请求按 workspaceIdentity 隔离且只能由对应版本清理", () => {
    const workspacePath = "/tmp/workspace-composer-prefill";
    const workspaceIdentityA = "ssh://user@host-a:/tmp/workspace-composer-prefill";
    const workspaceIdentityB = "ssh://user@host-b:/tmp/workspace-composer-prefill";
    const store = useZCodeSessionStore.getState();

    expect(store.requestComposerTextInsert(workspacePath, "first", workspaceIdentityA)).toBe(1);
    expect(
      store.requestComposerTextInsert(workspacePath, "second", workspaceIdentityA, {
        id: "plugin:demo@mkt",
        category: "plugins",
        label: "Demo",
        value: "demo@mkt",
        markdown: "[@Demo](plugin://demo@mkt)",
        data: {
          pluginId: "demo@mkt",
          icon: "https://cdn.example.com/demo.png",
        },
      }),
    ).toBe(2);
    store.requestComposerTextInsert(workspacePath, "isolated", workspaceIdentityB);
    store.requestComposerTextInsert(
      workspacePath,
      "[@Demo](plugin://demo@mkt)",
      workspaceIdentityA,
      {
        id: "plugin:demo@mkt",
        category: "plugins",
        label: "Demo",
        value: "demo@mkt",
        markdown: "[@Demo](plugin://demo@mkt)",
        data: { pluginId: "demo@mkt" },
      },
      "prepend-if-missing",
    );

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .composerTextInsertRequest,
    ).toEqual({
      requestId: 3,
      text: "[@Demo](plugin://demo@mkt)",
      mention: {
        id: "plugin:demo@mkt",
        category: "plugins",
        label: "Demo",
        value: "demo@mkt",
        markdown: "[@Demo](plugin://demo@mkt)",
        data: {
          pluginId: "demo@mkt",
        },
      },
      mode: "prepend-if-missing",
    });
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityB)
        .composerTextInsertRequest,
    ).toEqual({ requestId: 1, text: "isolated" });

    useZCodeSessionStore
      .getState()
      .clearComposerTextInsertRequest(workspacePath, 1, workspaceIdentityA);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .composerTextInsertRequest,
    ).toEqual(expect.objectContaining({ requestId: 3, mode: "prepend-if-missing" }));

    useZCodeSessionStore
      .getState()
      .clearComposerTextInsertRequest(workspacePath, 2, workspaceIdentityA);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .composerTextInsertRequest,
    ).toEqual(expect.objectContaining({ requestId: 3, mode: "prepend-if-missing" }));

    useZCodeSessionStore
      .getState()
      .clearComposerTextInsertRequest(workspacePath, 3, workspaceIdentityA);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .composerTextInsertRequest,
    ).toBeNull();
  });

  it("时间线到底请求即使目标 task 未切换也会递增，并且只能由对应版本清理", () => {
    const workspacePath = "/tmp/workspace-timeline-bottom";
    const workspaceIdentity = "ssh://user@host:/tmp/workspace-timeline-bottom";
    const store = useZCodeSessionStore.getState();

    expect(store.requestTimelineBottom(workspacePath, "task-1", workspaceIdentity)).toBe(1);
    expect(store.requestTimelineBottom(workspacePath, "task-1", workspaceIdentity)).toBe(2);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .timelineBottomRequest,
    ).toEqual({ requestId: 2, taskId: "task-1" });

    store.clearTimelineBottomRequest(workspacePath, 1, workspaceIdentity);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .timelineBottomRequest,
    ).toEqual({ requestId: 2, taskId: "task-1" });

    store.clearTimelineBottomRequest(workspacePath, 2, workspaceIdentity);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .timelineBottomRequest,
    ).toBeNull();
  });

  it("bindRuntimeProvider 在同路径不同 workspaceIdentity 下不应互相覆盖 supplier", () => {
    const workspacePath = "/tmp/workspace-runtime-identity";
    const workspaceIdentityA = "ssh://user@host-a:/tmp/workspace-runtime-identity";
    const workspaceIdentityB = "ssh://user@host-b:/tmp/workspace-runtime-identity";
    const customSupplierKeyA = buildCustomSupplierKey("provider-a");
    const customSupplierKeyB = buildCustomSupplierKey("provider-b");

    useZCodeSessionStore.getState().startDraft(workspacePath, "claude", workspaceIdentityA);
    useZCodeSessionStore.getState().setModelSelectionResolution(
      workspacePath,
      {
        selectedSupplierKey: customSupplierKeyA,
        isGhostSupplier: false,
        supplierMismatchReason: null,
      },
      workspaceIdentityA,
    );
    useZCodeSessionStore
      .getState()
      .bindRuntimeProvider(workspacePath, "claude", workspaceIdentityA);

    useZCodeSessionStore.getState().startDraft(workspacePath, "opencode", workspaceIdentityB);
    useZCodeSessionStore.getState().setModelSelectionResolution(
      workspacePath,
      {
        selectedSupplierKey: customSupplierKeyB,
        isGhostSupplier: false,
        supplierMismatchReason: null,
      },
      workspaceIdentityB,
    );
    useZCodeSessionStore
      .getState()
      .bindRuntimeProvider(workspacePath, "opencode", workspaceIdentityB);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityA)
        .selectedSupplierKey,
    ).toBe(customSupplierKeyA);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentityB)
        .selectedSupplierKey,
    ).toBe(customSupplierKeyB);
  });

  it("同一 remote workspace overlay 连续读取时应复用同一个快照引用", () => {
    const workspacePath = "/tmp/workspace-identity-overlay-snapshot";
    const workspaceIdentity = "ssh://user@host:/tmp/workspace-identity-overlay-snapshot";

    // M5②：旧 selectDraftProvider 的"归一后 no-op 不写 identity 桶"路径已随动作删除；
    // 这里保留 identity 读取回落 path 桶时快照引用复用的存活语义。
    useZCodeSessionStore.getState().startDraft(workspacePath, "opencode");

    const firstSnapshot = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    const secondSnapshot = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);

    expect(firstSnapshot.selectedProvider).toBe("glm");
    expect(firstSnapshot).toBe(secondSnapshot);

    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, "task-1", true);

    const thirdSnapshot = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);

    expect(thirdSnapshot).not.toBe(firstSnapshot);
    expect(thirdSnapshot.selectedProvider).toBe("glm");
    expect(thirdSnapshot.taskUnreadByTaskId["task-1"]).toBe(true);
  });

  it("workspaceIdentity overlay 应优先使用 identity 桶的 draftSessionId", () => {
    const workspacePath = "/tmp/workspace-remote-draft-session";
    const workspaceIdentity = "remote:ssh:localhost:2222:root:/tmp/workspace-remote-draft-session";

    useZCodeSessionStore.getState().setDraftSessionId(workspacePath, "sess-path-stale");
    useZCodeSessionStore
      .getState()
      .setDraftSessionId(workspacePath, "sess-identity-current", workspaceIdentity);

    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftSessionId).toBe(
      "sess-path-stale",
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .draftSessionId,
    ).toBe("sess-identity-current");
  });

  it("workspaceIdentity overlay 应优先读取 identity 桶的瞬时状态", () => {
    const workspacePath = "/tmp/workspace-remote-transient-state";
    const workspaceIdentity =
      "remote:ssh:localhost:2222:root:/tmp/workspace-remote-transient-state";
    const taskId = "task-remote-transient";
    const identityOptions = [createModelConfigOption("glm-identity")];
    const pathOptions = [createModelConfigOption("glm-path")];

    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
    useZCodeSessionStore.getState().bumpTaskListVersion(workspacePath, workspaceIdentity);
    useZCodeSessionStore.getState().bumpTaskListVersion(workspacePath, workspaceIdentity);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, identityOptions, workspaceIdentity);
    useZCodeSessionStore
      .getState()
      .setTaskUnreadIndicator(workspacePath, taskId, true, workspaceIdentity);

    useZCodeSessionStore.getState().startDraft(workspacePath);
    useZCodeSessionStore.getState().bumpTaskListVersion(workspacePath);
    useZCodeSessionStore.getState().setTaskConfigOptions(workspacePath, taskId, pathOptions);
    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, false);

    const workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);

    expect(readModelConfigValue(workspaceState.taskConfigOptionsByTaskId[taskId])).toBe(
      "glm-identity",
    );
    expect(workspaceState.taskUnreadByTaskId[taskId]).toBe(true);
    expect(workspaceState.taskListVersion).toBe(2);
    expect(workspaceState.draftFocusVersion).toBe(2);
  });

  it("startDraft 选择旧 provider 时也会立即归一最近一次选择", () => {
    const storage = createStorageMock();
    vi.stubGlobal("window", { localStorage: storage });

    useZCodeSessionStore.getState().startDraft("/tmp/workspace-draft", "codex");

    expect(storage.getItem(LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY)).toBe("glm");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState("/tmp/workspace-draft").selectedProvider,
    ).toBe("glm");
  });

  it("startDraft 传入同 provider 时不应把 custom supplier 重置为 native", () => {
    const workspacePath = "/tmp/workspace-draft-same-provider";
    const customSupplierKey = buildCustomSupplierKey("provider-a");

    useZCodeSessionStore.getState().startDraft(workspacePath, "claude");
    useZCodeSessionStore.getState().setModelSelectionResolution(workspacePath, {
      selectedSupplierKey: customSupplierKey,
      isGhostSupplier: false,
      supplierMismatchReason: null,
    });

    useZCodeSessionStore.getState().startDraft(workspacePath, "claude");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.selectedProvider).toBe("glm");
    expect(workspaceState.selectedSupplierKey).toBe(customSupplierKey);
  });

  it("startDraft 会递增草稿聚焦版本，供输入框在新建任务后立即聚焦", () => {
    const storage = createStorageMock();
    vi.stubGlobal("window", { localStorage: storage });

    const workspacePath = "/tmp/workspace-focus";
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftFocusVersion).toBe(
      0,
    );

    useZCodeSessionStore.getState().startDraft(workspacePath);
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftFocusVersion).toBe(
      1,
    );

    useZCodeSessionStore.getState().startDraft(workspacePath, "opencode");
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftFocusVersion).toBe(
      2,
    );
  });

  it("startDraft 从 active task 新建且透传同 provider 时会继承输入框完整配置", () => {
    const workspacePath = "/tmp/workspace-new-task-inherit-active-config";
    const taskId = "task-provider-a";
    const taskModel = "provider-a/model-a";
    const workspaceModel = "account:bigmodel-individual-coding-plan/GLM-5.2";

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption(workspaceModel)]);
    useZCodeSessionStore.getState().setDraftSessionId(workspacePath, "draft-glm");
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [
        createModelConfigOption(taskModel),
        createModeConfigOption("yolo"),
        createThoughtConfigOption("max"),
      ]);

    useZCodeSessionStore.getState().startDraft(workspacePath, "glm");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.activeTaskId).toBeNull();
    expect(workspaceState.draftSessionId).toBeNull();
    expect(readModelConfigValue(workspaceState.configOptions)).toBe(taskModel);
    expect(readModeConfigOption(workspaceState.configOptions)?.currentValue).toBe("yolo");
    expect(
      workspaceState.configOptions?.find((option) => option.category === "thought_level")
        ?.currentValue,
    ).toBe("max");
  });

  it("startDraft 在 task 级缓存缺失时仍继承当前输入框配置", () => {
    const workspacePath = "/tmp/workspace-new-task-inherit-current-config";
    const taskId = "task-projection-only";
    const taskModel = "output-token-preflight-e2e/otb-preflight-64k";

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [
        createModelConfigOption(taskModel),
        createModeConfigOption("yolo"),
        createThoughtConfigOption("max"),
      ]);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);

    // 模拟 protocol-v4 投影已经更新当前工具条，但尚未写入 legacy task 级缓存。
    useZCodeSessionStore.getState().startDraft(workspacePath, "glm");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
  });

  it("startDraft 在 task 级缓存为空时仍继承当前输入框配置", () => {
    const workspacePath = "/tmp/workspace-new-task-inherit-empty-task-config";
    const taskId = "task-projection-with-empty-cache";
    const taskModel = "custom-provider/custom-vision-model";

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [
        createModelConfigOption(taskModel),
        createModeConfigOption("yolo"),
        createThoughtConfigOption("max"),
      ]);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {
        ...state.workspaces,
        [workspacePath]: {
          ...state.getWorkspaceState(workspacePath),
          taskConfigOptionsByTaskId: { [taskId]: [] },
        },
      },
    }));

    // 模拟首轮 session 先以空目录建立，随后 protocol-v4 只更新当前工具条投影。
    useZCodeSessionStore.getState().startDraft(workspacePath, "glm");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
  });

  it("草稿目录水合不应清掉从 active task 继承的预热配置", () => {
    const workspacePath = "/tmp/workspace-new-task-hydration-race";
    const taskId = "task-custom-model";
    const taskModel = "custom-provider/gpt-5.6-sol";

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [
        createModelConfigOption(taskModel),
        createModeConfigOption("yolo"),
        createThoughtConfigOption("max"),
      ]);
    useZCodeSessionStore.getState().startDraft(workspacePath, "glm");

    // 模拟新草稿 mount 后异步完成的 workspace catalog 水合。
    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption("glm/GLM-5.2")]);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
  });

  it("grouped 草稿在不同 New task 入口之间切换时会更新创建位置", () => {
    const workspacePath = "/tmp/workspace-grouped-draft-placement";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);

    useZCodeSessionStore
      .getState()
      .startDraft(workspacePath, undefined, undefined, { groupedDraftPlacement: { type: "top" } });
    const topDraft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;

    useZCodeSessionStore
      .getState()
      .startDraft(workspacePath, undefined, undefined, { groupedDraftPlacement: { type: "top" } });
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).groupedDraftTask).toBe(
      topDraft,
    );

    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "group-a" },
    });

    const groupDraft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;
    expect(groupDraft?.placement).toEqual({ type: "group", groupId: "group-a" });
    expect(groupDraft?.createdAt).toBe(1000);
    expect(nowSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it("grouped 草稿提升位置落库后可以按 task 消费", () => {
    const workspacePath = "/tmp/workspace-grouped-draft-consume";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2000);
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "group-a" },
    });
    const groupedDraftTask = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;
    expect(groupedDraftTask).not.toBeNull();
    useZCodeSessionStore
      .getState()
      .promoteGroupedDraftTask(workspacePath, "task-promoted", groupedDraftTask!);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath)
        .promotedGroupedDraftTaskByTaskId["task-promoted"]?.placement,
    ).toEqual({ type: "group", groupId: "group-a" });
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).optimisticTaskListByTaskId[
        "task-promoted"
      ],
    ).toMatchObject({
      taskId: "task-promoted",
      title: "",
      workspacePath,
      createdAt: groupedDraftTask?.createdAt,
      updatedAt: 0,
      mode: "default",
    });

    useZCodeSessionStore.getState().clearPromotedGroupedDraftTask(workspacePath, "task-promoted");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath)
        .promotedGroupedDraftTaskByTaskId["task-promoted"],
    ).toBeUndefined();
    nowSpy.mockRestore();
  });

  it("旧创建请求完成时使用原草稿位置且不清除后创建的草稿", () => {
    const workspacePath = "/tmp/workspace-grouped-draft-interleaved-create";
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "group-a" },
    });
    const originalDraft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;
    expect(originalDraft).not.toBeNull();

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "existing-task");
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "group-b" },
    });
    const newerDraft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;
    expect(newerDraft?.draftId).not.toBe(originalDraft?.draftId);

    useZCodeSessionStore
      .getState()
      .promoteGroupedDraftTask(workspacePath, "created-task-a", originalDraft!);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.groupedDraftTask).toBe(newerDraft);
    expect(workspaceState.promotedGroupedDraftTaskByTaskId["created-task-a"]?.placement).toEqual({
      type: "group",
      groupId: "group-a",
    });
  });

  it("grouped 草稿提升不覆盖先于 ACK 到达的 task 元数据", () => {
    const workspacePath = "/tmp/workspace-grouped-draft-meta-race";
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "top" },
    });
    const groupedDraftTask = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath).groupedDraftTask;
    const task = createTaskMeta({
      taskId: "task-meta-first",
      title: "权威标题已到达",
      workspacePath,
      createdAt: 10,
      updatedAt: 20,
    });
    useZCodeSessionStore.getState().upsertOptimisticTaskListItem(workspacePath, task);

    useZCodeSessionStore
      .getState()
      .promoteGroupedDraftTask(workspacePath, task.taskId, groupedDraftTask!);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).optimisticTaskListByTaskId[
        task.taskId
      ],
    ).toBe(task);
  });

  it("grouped 草稿存在时选择已有任务只清除草稿，不生成提升标记", () => {
    const workspacePath = "/tmp/workspace-grouped-draft-existing-task-navigation";
    useZCodeSessionStore.getState().startDraft(workspacePath, undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "group-a" },
    });

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "existing-root-task");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.groupedDraftTask).toBeNull();
    expect(workspaceState.promotedGroupedDraftTaskByTaskId["existing-root-task"]).toBeUndefined();
  });

  it("切换 workspace 时可以迁移 grouped 草稿位置", () => {
    const sourceWorkspacePath = "/tmp/workspace-grouped-draft-source";
    const targetWorkspacePath = "/tmp/workspace-grouped-draft-target";
    const placement = { type: "group" as const, groupId: "group-a" };

    useZCodeSessionStore.getState().startDraft(sourceWorkspacePath, undefined, undefined, {
      groupedDraftPlacement: placement,
    });
    const sourceDraft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(sourceWorkspacePath).groupedDraftTask;
    expect(sourceDraft).not.toBeNull();

    useZCodeSessionStore.getState().startDraft(targetWorkspacePath, undefined, undefined, {
      groupedDraftPlacement: sourceDraft!.placement,
    });
    // 修复原因：grouped 左侧 New task 行是创建位置，不是 workspace 本身。
    // 切 workspace 只迁移草稿目标，不能让左侧临时行凭空消失。
    useZCodeSessionStore.getState().clearGroupedDraftTask(sourceWorkspacePath);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(sourceWorkspacePath).groupedDraftTask,
    ).toBeNull();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(targetWorkspacePath).groupedDraftTask,
    ).toMatchObject({
      workspacePath: targetWorkspacePath,
      placement,
    });
  });

  it("草稿态重复点击新建任务时不应清空 slashCommands", () => {
    const workspacePath = "/tmp/workspace-draft-slash-commands";
    const slashCommands = [
      { name: "status", description: "查看当前状态" },
      { name: "review", description: "发起代码审查" },
    ];

    useZCodeSessionStore.getState().setSlashCommands(workspacePath, slashCommands);

    useZCodeSessionStore.getState().startDraft(workspacePath);
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).slashCommands).toEqual(
      slashCommands,
    );

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task-from-list");
    useZCodeSessionStore.getState().startDraft(workspacePath);
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).slashCommands).toEqual(
      [],
    );
  });

  it("workspaceIdentity 会隔离 workspace 级命令、初始化与模型切换状态", () => {
    const workspacePath = "/tmp/workspace-same-path-state";
    const identityA = "ssh://host-a/tmp/workspace-same-path-state";
    const identityB = "ssh://host-b/tmp/workspace-same-path-state";
    const slashCommands = [{ name: "review", description: "发起代码审查" }];

    useZCodeSessionStore.getState().setSlashCommands(workspacePath, slashCommands, identityA);
    useZCodeSessionStore.getState().setWorkspaceInitState(workspacePath, "ready", null, identityA);
    useZCodeSessionStore
      .getState()
      .startModelSwitch(workspacePath, "switch-a", "settingModel", identityA);

    const workspaceStateA = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, identityA);
    const workspaceStateB = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, identityB);

    expect(workspaceStateA.slashCommands).toEqual(slashCommands);
    expect(workspaceStateB.slashCommands).toEqual([]);
    expect(workspaceStateA.workspaceInit.status).toBe("ready");
    expect(workspaceStateB.workspaceInit.status).toBe("idle");
    expect(workspaceStateA.modelSwitchRequestId).toBe("switch-a");
    expect(workspaceStateA.modelSwitchPending).toBe(true);
    expect(workspaceStateB.modelSwitchRequestId).toBeNull();
    expect(workspaceStateB.modelSwitchPending).toBe(false);
  });

  it("workspaceIdentity 已存在时不再动态合并 path 桶里的 task config", () => {
    const workspacePath = "/tmp/workspace-same-path-model-config";
    const identityA = "ssh://host-a/tmp/workspace-same-path-model-config";
    const identityB = "ssh://host-b/tmp/workspace-same-path-model-config";

    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, "task-1", [createModelConfigOption("glm-path")]);
    useZCodeSessionStore.getState().startDraft(workspacePath, "glm", identityA);
    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption("glm-identity-b")], identityB);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        "task-1",
        [createModelConfigOption("glm-identity-a")],
        identityA,
      );

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, identityA)
        .taskConfigOptionsByTaskId["task-1"]?.[0]?.currentValue,
    ).toBe("glm-identity-a");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, identityB)
        .taskConfigOptionsByTaskId["task-1"],
    ).toBeUndefined();
  });

  it("workspaceIdentity 首次写入只迁移明确属于该 identity 的 path task 状态", () => {
    const workspacePath = "/tmp/workspace-same-path-task-cache";
    const workspaceIdentity = "ssh://host-a/tmp/workspace-same-path-task-cache";
    const otherWorkspaceIdentity = "ssh://host-b/tmp/workspace-same-path-task-cache";
    const taskId = "identity-task";
    const otherTaskId = "other-task";
    useZCodeSessionStore.getState().setTaskListCache(workspacePath, [
      createTaskMeta({
        taskId,
        workspacePath,
        workspaceIdentity,
        model: "glm-path",
      }),
      createTaskMeta({
        taskId: otherTaskId,
        workspacePath,
        workspaceIdentity: otherWorkspaceIdentity,
        model: "glm-other",
      }),
    ]);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [createModelConfigOption("glm-path")]);
    useZCodeSessionStore.getState().setTaskRuntimeState(workspacePath, taskId, "streaming");
    useZCodeSessionStore
      .getState()
      .setTaskError(workspacePath, taskId, createZCodeError({ taskId }));
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, otherTaskId, [createModelConfigOption("glm-other")]);

    useZCodeSessionStore
      .getState()
      .setConfigOptions(
        workspacePath,
        [createModelConfigOption("glm-identity")],
        workspaceIdentity,
      );

    const workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);

    expect(workspaceState.configOptions?.[0]?.currentValue).toBe("glm-identity");
    expect(workspaceState.taskListCache?.map((task) => task.taskId)).toEqual([taskId]);
    expect(readModelConfigValue(workspaceState.taskConfigOptionsByTaskId[taskId])).toBe("glm-path");
    expect(getTaskRuntimeState(workspaceState, taskId).status).toBe("streaming");
    expect(getTaskUiState(workspaceState, taskId).error?.message).toBe("命令执行失败");
    expect(workspaceState.taskConfigOptionsByTaskId[otherTaskId]).toBeUndefined();
  });

  it("modelSwitch 状态只允许最新 requestId 生效与收敛", () => {
    const workspacePath = "/tmp/workspace-model-switch";
    const requestId1 = "switch-1";
    const requestId2 = "switch-2";

    useZCodeSessionStore.getState().startModelSwitch(workspacePath, requestId1, "settingModel");
    useZCodeSessionStore
      .getState()
      .updateModelSwitchStage(workspacePath, requestId1, "restartingRuntime");
    useZCodeSessionStore.getState().startModelSwitch(workspacePath, requestId2, "syncingSession");

    // 旧请求结束不应覆盖新请求状态
    useZCodeSessionStore.getState().finishModelSwitch(workspacePath, requestId1);
    let workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.modelSwitchPending).toBe(true);
    expect(workspaceState.modelSwitchRequestId).toBe(requestId2);
    expect(workspaceState.modelSwitchStage).toBe("syncingSession");

    // 当前请求结束后才回到 idle
    useZCodeSessionStore.getState().finishModelSwitch(workspacePath, requestId2);
    workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.modelSwitchPending).toBe(false);
    expect(workspaceState.modelSwitchRequestId).toBeNull();
    expect(workspaceState.modelSwitchStage).toBe("idle");
  });

  it("removeTaskState 删除当前任务时会同步关闭右侧详情态", () => {
    const workspacePath = "/tmp/workspace-delete";
    const taskId = "task-active";

    useZCodeSessionStore
      .getState()
      .upsertOptimisticTaskListItem(workspacePath, createTaskMeta({ taskId, workspacePath }));
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore.getState().setTaskRuntimeState(workspacePath, taskId, "streaming");

    useZCodeSessionStore.getState().removeTaskState(workspacePath, taskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.activeTaskId).toBeNull();
    expect(getWorkspaceDisplayedTaskState(workspaceState).taskStatus).toBe("idle");
    expect(getWorkspaceDisplayedTaskState(workspaceState).taskError).toBeNull();
    expect(workspaceState.optimisticTaskListByTaskId[taskId]).toBeUndefined();
    expect(workspaceState.taskRuntimeByTaskId[taskId]).toBeUndefined();
  });

  it("权限请求会按 task 维度保存，切换任务后仍可恢复", () => {
    const workspacePath = "/tmp/workspace-task-ui";
    const firstTaskId = "task-plan";
    const secondTaskId = "task-empty";
    const permissionRequest = createPermissionRequest({ taskId: firstTaskId });

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, firstTaskId, permissionRequest);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, firstTaskId);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, secondTaskId);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, firstTaskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskUiState(workspaceState, firstTaskId)).toEqual({
      ...DEFAULT_TASK_UI_STATE,
      permissionRequest,
    });
    expect(getTaskUiState(workspaceState, secondTaskId)).toEqual(DEFAULT_TASK_UI_STATE);
  });

  it("问答草稿会按 workspace、task 和 request 隔离，并可在请求收口后清理", () => {
    const workspacePath = "/tmp/workspace-elicitation-draft";
    const firstTaskId = "task-a";
    const secondTaskId = "task-b";
    const requestId = "ask-1";
    const workspaceIdentity = "ssh://host-a/workspace";
    const draft = {
      questionIndex: 1,
      drafts: {
        "0:方案": { selectedValues: ["safe"], customAnswer: "" },
      },
    };

    useZCodeSessionStore
      .getState()
      .setTaskElicitationFormDraft(workspacePath, firstTaskId, requestId, draft, workspaceIdentity);

    let workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    expect(
      getTaskUiState(workspaceState, firstTaskId).elicitationFormDraftsByRequestId[requestId],
    ).toEqual(draft);
    expect(
      getTaskUiState(workspaceState, secondTaskId).elicitationFormDraftsByRequestId[requestId],
    ).toBeUndefined();
    const otherWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, "ssh://host-b/workspace");
    expect(
      getTaskUiState(otherWorkspaceState, firstTaskId).elicitationFormDraftsByRequestId[requestId],
    ).toBeUndefined();

    useZCodeSessionStore
      .getState()
      .removeTaskElicitationFormDraft(workspacePath, firstTaskId, requestId, workspaceIdentity);

    workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    expect(
      getTaskUiState(workspaceState, firstTaskId).elicitationFormDraftsByRequestId[requestId],
    ).toBeUndefined();
  });

  it("连续收到多个权限请求时会按顺序排队，响应当前请求后自动切到下一条", () => {
    const workspacePath = "/tmp/workspace-task-permission-queue";
    const taskId = "task-permission-queue";
    const firstPermissionRequest = createPermissionRequest({
      taskId,
      requestId: "perm-1",
      description: "允许读取 about.txt",
    });
    const secondPermissionRequest = createPermissionRequest({
      taskId,
      requestId: "perm-2",
      description: "允许读取 setting.json",
    });

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, firstPermissionRequest);
    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, secondPermissionRequest);

    let workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskUiState(workspaceState, taskId)).toEqual({
      ...DEFAULT_TASK_UI_STATE,
      permissionRequest: firstPermissionRequest,
      pendingPermissionRequests: [secondPermissionRequest],
    });

    useZCodeSessionStore.getState().removeTaskPermissionRequest(workspacePath, taskId, "perm-1");

    workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskUiState(workspaceState, taskId)).toEqual({
      ...DEFAULT_TASK_UI_STATE,
      permissionRequest: secondPermissionRequest,
    });
  });

  it("重复收到相同权限请求时不会重建 task UI state", () => {
    const workspacePath = "/tmp/workspace-task-permission-duplicate";
    const taskId = "task-permission-duplicate";
    const firstPermissionRequest = createPermissionRequest({ taskId, requestId: "perm-duplicate" });
    const duplicatePermissionRequest = createPermissionRequest({
      taskId,
      requestId: "perm-duplicate",
    });

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, firstPermissionRequest);

    const firstWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    const firstTaskUiState = getTaskUiState(firstWorkspaceState, taskId);

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, duplicatePermissionRequest);

    const secondWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(secondWorkspaceState).toBe(firstWorkspaceState);
    expect(getTaskUiState(secondWorkspaceState, taskId)).toBe(firstTaskUiState);
  });

  it("重复清理已移除的权限请求时不会重建 task UI state", () => {
    const workspacePath = "/tmp/workspace-task-permission-response-duplicate";
    const taskId = "task-permission-response-duplicate";
    const permissionRequest = createPermissionRequest({ taskId, requestId: "perm-response" });

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, permissionRequest);
    useZCodeSessionStore
      .getState()
      .removeTaskPermissionRequest(workspacePath, taskId, "perm-response");

    const firstWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);

    useZCodeSessionStore
      .getState()
      .removeTaskPermissionRequest(workspacePath, taskId, "perm-response");

    const secondWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(secondWorkspaceState).toBe(firstWorkspaceState);
  });

  it("task 错误会按 task 维度保存在内存里，切换任务后仍可恢复", () => {
    const workspacePath = "/tmp/workspace-task-error";
    const firstTaskId = "task-error";
    const secondTaskId = "task-other";
    const error = createZCodeError({ taskId: firstTaskId });

    useZCodeSessionStore.getState().setTaskError(workspacePath, firstTaskId, error);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, firstTaskId);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, secondTaskId);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, firstTaskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskUiState(workspaceState, firstTaskId).error).toEqual(error);
    expect(getTaskUiState(workspaceState, secondTaskId).error).toBeNull();
  });

  it("草稿态错误会保留在 workspace 内存里，并在重新新建草稿时清空", () => {
    const workspacePath = "/tmp/workspace-draft-error";
    const error = createZCodeError({ taskId: undefined });

    useZCodeSessionStore.getState().setDraftError(workspacePath, error);
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftError).toEqual(
      error,
    );

    useZCodeSessionStore.getState().startDraft(workspacePath);
    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).draftError).toBeNull();
  });

  it("当前 task 被右键标记未读后，再次打开会同时清掉 optimistic 蓝点", () => {
    const workspacePath = "/tmp/workspace-task-read";
    const taskId = "task-unread";
    useZCodeSessionStore
      .getState()
      .upsertOptimisticTaskListItem(workspacePath, createTaskMeta({ taskId, workspacePath }));
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, true);
    useZCodeSessionStore
      .getState()
      .upsertOptimisticTaskListItem(
        workspacePath,
        createTaskMeta({ taskId, workspacePath, unreadAt: 123 }),
      );

    expect(
      getTaskUnreadIndicator(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
        taskId,
      ),
    ).toBe(true);

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskUnreadIndicator(workspaceState, taskId)).toBe(false);
    expect(workspaceState.optimisticTaskListByTaskId[taskId]?.unreadAt).toBeUndefined();
  });

  it("重复清理已读 task 时不会重建 workspace state", () => {
    const workspacePath = "/tmp/workspace-task-read-noop";
    const taskId = "task-unread-noop";
    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, true);
    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, false);

    const firstWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);

    useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, false);

    const secondWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(secondWorkspaceState).toBe(firstWorkspaceState);
  });

  it("切到已有 task 时会用 task meta 预热 task 配置，且不覆盖 workspace 默认配置", () => {
    const workspacePath = "/tmp/workspace-task-model-preload";
    const taskId = "task-glm51";
    const staleWorkspaceModel = "glm-0531[1m]";
    const taskModel = "bigmodel-api/GLM-5.1";

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption(staleWorkspaceModel)]);
    useZCodeSessionStore.getState().upsertOptimisticTaskListItem(
      workspacePath,
      createTaskMeta({
        taskId,
        workspacePath,
        provider: "glm",
        model: taskModel,
      }),
    );

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(readModelConfigValue(workspaceState.configOptions)).toBe(staleWorkspaceModel);
    expect(readModelConfigValue(workspaceState.taskConfigOptionsByTaskId[taskId])).toBe(
      encodeCustomModelValue("bigmodel-api", "GLM-5.1"),
    );
    expect(workspaceState.taskConfigOptionsStatusByTaskId[taskId]).toBe("loading");
  });

  it("active task 配置更新只写 task 配置桶，不覆盖 workspace 默认配置", () => {
    const workspacePath = "/tmp/workspace-task-config-isolation";
    const taskId = "task-active-config";
    const workspaceModel = "glm-0531[1m]";
    const taskModel = "bigmodel-api/GLM-5.1";

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption(workspaceModel)]);
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [createModelConfigOption(taskModel)]);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(readModelConfigValue(workspaceState.configOptions)).toBe(workspaceModel);
    expect(readModelConfigValue(workspaceState.taskConfigOptionsByTaskId[taskId])).toBe(taskModel);
    expect(workspaceState.taskConfigOptionsStatusByTaskId[taskId]).toBe("ready");
  });

  it("相同 workspace 配置不会重复通知订阅者", () => {
    const workspacePath = "/tmp/workspace-config-options-dedupe";
    const modelValue = "account:zai-start-plan/GLM-5.2";
    let notificationCount = 0;
    const unsubscribe = useZCodeSessionStore.subscribe(() => {
      notificationCount += 1;
    });

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption(modelValue)]);
    expect(notificationCount).toBe(1);

    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, [createModelConfigOption(modelValue)]);

    unsubscribe();
    expect(notificationCount).toBe(1);
  });

  it("相同 task 配置不会重复通知订阅者", () => {
    const workspacePath = "/tmp/workspace-task-config-options-dedupe";
    const taskId = "task-config-dedupe";
    const modelValue = "account:zai-start-plan/GLM-5.2";
    let notificationCount = 0;
    const unsubscribe = useZCodeSessionStore.subscribe(() => {
      notificationCount += 1;
    });

    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [createModelConfigOption(modelValue)]);
    expect(notificationCount).toBe(1);

    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(workspacePath, taskId, [createModelConfigOption(modelValue)]);

    unsubscribe();
    expect(notificationCount).toBe(1);
  });

  it("任务前进后退选择目标时不会覆盖浏览器式历史位置", () => {
    const workspacePath = "/tmp/workspace-task-nav";

    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task-a");
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task-b");

    const backEntry = useZCodeSessionStore.getState().taskNavGoBack();
    expect(backEntry?.taskId).toBe("task-a");
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, "task-a");

    expect(canGoForward(useZCodeSessionStore.getState().taskNavHistory)).toBe(true);
    expect(useZCodeSessionStore.getState().taskNavGoForward()?.taskId).toBe("task-b");
  });

  it("removeTaskState 会同时清理 task 级权限请求", () => {
    const workspacePath = "/tmp/workspace-remove-task-ui";
    const taskId = "task-remove-ui";

    useZCodeSessionStore
      .getState()
      .setTaskPermissionRequest(workspacePath, taskId, createPermissionRequest({ taskId }));

    useZCodeSessionStore.getState().removeTaskState(workspacePath, taskId);

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(workspaceState.taskUiByTaskId[taskId]).toBeUndefined();
  });

  it("task usage 会按 task 保存，切换运行态时不丢失", () => {
    const workspacePath = "/tmp/workspace-task-usage";
    const taskId = "task-usage";

    useZCodeSessionStore.getState().setTaskUsage(workspacePath, taskId, {
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
    useZCodeSessionStore.getState().setTaskRuntimeState(workspacePath, taskId, "streaming");
    useZCodeSessionStore.getState().setTaskRuntimeState(workspacePath, taskId, "completed");

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspacePath);
    expect(getTaskRuntimeState(workspaceState, taskId)).toEqual({
      ...DEFAULT_TASK_RUNTIME_STATE,
      status: "completed",
      error: null,
      apiRetry: null,
      usage: {
        used: 53000,
        size: 200000,
        cost: { amount: 0.045, currency: "USD" },
      },
    });
  });

  it("task contextWindow 单独更新，不覆盖已有 usage", () => {
    const workspacePath = "/tmp/workspace-task-context-window";
    const taskId = "task-context-window";

    useZCodeSessionStore.getState().setTaskUsage(workspacePath, taskId, {
      used: 11804,
      size: 200000,
      cost: null,
      cache: {
        inputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        hitRate: 0.4,
      },
      breakdown: [{ source: "messages", chars: 1200 }],
    });
    useZCodeSessionStore.getState().setTaskContextWindow(workspacePath, taskId, 1000000);

    const runtime = getTaskRuntimeState(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    );
    expect(runtime.contextWindow).toBe(1000000);
    expect(runtime.usage).toEqual({
      used: 11804,
      size: 200000,
      cost: null,
      cache: {
        inputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        hitRate: 0.4,
      },
      breakdown: [{ source: "messages", chars: 1200 }],
    });
  });

  it("相同 task usage 不重复通知订阅者", () => {
    const workspacePath = "/tmp/workspace-task-usage-dedupe";
    const taskId = "task-usage-dedupe";
    let notificationCount = 0;
    const unsubscribe = useZCodeSessionStore.subscribe(() => {
      notificationCount += 1;
    });

    useZCodeSessionStore.getState().setTaskUsage(workspacePath, taskId, {
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
    expect(notificationCount).toBe(1);

    useZCodeSessionStore.getState().setTaskUsage(workspacePath, taskId, {
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });

    unsubscribe();
    expect(notificationCount).toBe(1);
  });

  it("configOptionsStatus 写入 workspace identity 时不污染 path 桶", () => {
    const workspacePath = "/tmp/workspace-config-status-identity";
    const workspaceIdentity = "ssh://host-a/tmp/workspace-config-status-identity";

    useZCodeSessionStore.getState().setConfigOptionsStatus(workspacePath, "loading");
    useZCodeSessionStore
      .getState()
      .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).configOptionsStatus,
    ).toBe("loading");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .configOptionsStatus,
    ).toBe("error");
  });
});
