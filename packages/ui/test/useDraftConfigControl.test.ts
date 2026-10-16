import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { resolveEffectiveModelSelection, type ProviderRegistryView } from "@zcode/provider";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useDraftConfigControl as useActualDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { seedImportedSessionDraft } from "@/v4/composer/newTaskDraft.js";

const { prepareWorkspaceMock } = vi.hoisted(() => ({
  prepareWorkspaceMock: vi.fn(),
}));

const { toastMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
}));

vi.mock("@/hooks/useWorkspacePrepare.js", () => ({
  prepareWorkspaceWithZCodeSessionService: prepareWorkspaceMock,
}));

vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({ readWorkspacePresentation: vi.fn() }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const WORKSPACE_PRESENTATION: ZCodeConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [{ value: "build", name: "Build" }],
  },
];

const CUSTOM_COMMANDS = [
  {
    name: "review",
    description: "Review current changes",
    source: "custom" as const,
  },
];

const selectionServices = new Map<string, IModelSelectionService>();
// 用真实纯解析算法模拟 Host，只省略 RPC；同内容的 fixture 保持同一 Service owner。
function useDraftConfigControl(
  params: Omit<Parameters<typeof useActualDraftConfigControl>[0], "modelSelectionService"> & {
    modelSelectionView: ModelSelectionView | null;
  },
) {
  const view = params.modelSelectionView;
  const key = JSON.stringify(view);
  if (view && !selectionServices.has(key))
    selectionServices.set(key, {
      getView: async (input) => ({
        ...view,
        ...(input
          ? resolveEffectiveModelSelection({
              selection: input.selection,
              registry: view as unknown as ProviderRegistryView,
              classifyProvider: () => "ordinary",
            })
          : {}),
      }),
      onDidChange: () => ({ dispose: () => {} }),
    });
  return useActualDraftConfigControl({
    ...params,
    modelSelectionService: view ? selectionServices.get(key)! : null,
  });
}

function modelSelectionView(
  revision: number,
  modelIds: readonly string[],
  preferredModelId: string,
): ModelSelectionView {
  return {
    revision,
    preferredSelection: {
      providerId: "provider",
      modelId: preferredModelId,
    },
    providers: [
      {
        providerId: "provider",
        config: {},
        models: modelIds.map((modelId) => ({
          modelId,
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
            },
          },
        })),
      },
    ],
  } as ModelSelectionView;
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const storage = new Map<string, string>();
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

describe("useDraftConfigControl slash command hydration", () => {
  it.each(["root", "empty-root", "recent", "default", "unavailable"])(
    "SHARE30 首次导入与普通新任务一致：%s，保留 Root 正文且不更新 Recent",
    async (source) => {
      const root = createRoot(installMinimalDom());
      const workspacePath = "/import";
      const selection = {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const view = {
        ...modelSelectionView(1, source === "unavailable" ? [] : ["model"], "model"),
        preferredSelection: selection,
      };
      if (source !== "default" && source !== "unavailable")
        captureComposerRecentSubmission(workspacePath, {
          modelSelection: selection,
          mode: "yolo",
        })();
      if (source === "root" || source === "empty-root")
        persistV4ComposerDraft(workspacePath, undefined, "__draft__", {
          text: "KEEP ROOT",
          editorStateJson: "ROOT EDITOR",
          mode: "plan",
          ...(source === "root" ? { modelSelection: selection } : {}),
        });
      const originalRoot = readV4ComposerDraft(workspacePath, undefined, "__draft__");
      const recentBefore = window.localStorage.getItem(
        `zcode-model-selection-recent-v1:${workspacePath}`,
      );
      seedImportedSessionDraft({ workspacePath, sessionId: "imported", reused: false });
      let control: ReturnType<typeof useDraftConfigControl>;
      function Probe({ sessionId }: { sessionId: string | null }) {
        control = useDraftConfigControl({
          workspacePath,
          sessionId,
          sessionConfig: { mode: "build" },
          agentStartupAllowed: false,
          modelSelectionView: view,
        });
        return null;
      }
      await act(async () => root.render(createElement(Probe, { sessionId: "imported" })));
      const imported = control!.draftConfig;
      expect(control!.composerDraft.text).toBe("");
      expect(control!.composerDraft.editorStateJson).toBeUndefined();
      expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")).toEqual(originalRoot);
      await act(async () => root.render(createElement(Probe, { sessionId: null })));
      expect(control!.draftConfig).toEqual(imported);
      expect(window.localStorage.getItem(`zcode-model-selection-recent-v1:${workspacePath}`)).toBe(
        recentBefore,
      );
      act(() => root.unmount());
    },
  );

  it.each(["none", "mode", "model"])(
    "SHARE31 View 延迟不被空 snapshot 抢先锁定；用户先编辑=%s",
    async (edited) => {
      const root = createRoot(installMinimalDom());
      const workspacePath = "/delayed-import";
      seedImportedSessionDraft({ workspacePath, sessionId: "imported", reused: false });
      let control: ReturnType<typeof useDraftConfigControl>;
      const readyView = {
        ...modelSelectionView(1, ["model"], "model"),
        preferredSelection: {
          providerId: "provider",
          modelId: "model",
          options: { reasoningLevel: "high" },
        },
      };
      function Probe({ ready }: { ready: boolean }) {
        control = useDraftConfigControl({
          workspacePath,
          sessionId: "imported",
          sessionConfig: { mode: "build" },
          agentStartupAllowed: false,
          modelSelectionView: ready ? readyView : null,
        });
        return null;
      }
      await act(async () => root.render(createElement(Probe, { ready: false })));
      expect(control!.composerDraft.mode).toBeUndefined();
      act(() => control!.updateComposerContent({ text: "content stays" }));
      if (edited === "mode") act(() => control!.handleDraftSwitchMode("plan"));
      if (edited === "model") {
        act(() => control!.handleDraftSelectModel("provider", "model"));
        act(() => control!.handleDraftSelectThought("low"));
      }
      await act(async () => root.render(createElement(Probe, { ready: true })));
      expect(control!.composerDraft.text).toBe("content stays");
      expect(control!.draftConfig.mode).toBe("build");
      expect(control!.draftConfig.planEnabled).toBe(edited === "mode");
      if (edited === "mode") expect(control!.composerDraft.modelSelection).toBeUndefined();
      else expect(control!.draftConfig.modelSelection?.modelId).toBe("model");
      if (edited === "model")
        expect(control!.draftConfig.modelSelection?.options?.reasoningLevel).toBe("low");
      expect(control!.composerDraft.initializeFromNewTask).toBeUndefined();
      act(() => root.unmount());
    },
  );

  it("SHARE32 使用导入实际 identity，重复导入／目标已有草稿不覆盖", () => {
    installMinimalDom();
    const workspacePath = "/same";
    persistV4ComposerDraft(workspacePath, "ssh://one/same", "__draft__", {
      text: "remote",
      mode: "yolo",
    });
    persistV4ComposerDraft(workspacePath, undefined, "__draft__", { text: "local", mode: "plan" });
    seedImportedSessionDraft({ workspacePath, sessionId: "new", reused: false });
    expect(readV4ComposerDraft(workspacePath, undefined, "new")).toMatchObject({
      text: "",
      mode: "build",
      planEnabled: true,
    });
    expect(readV4ComposerDraft(workspacePath, "ssh://one/same", "new")).toBeNull();
    seedImportedSessionDraft({
      workspacePath,
      workspaceIdentity: "ssh://two/same",
      sessionId: "new",
      reused: false,
    });
    expect(readV4ComposerDraft(workspacePath, "ssh://two/same", "new")?.mode).toBeUndefined();
    persistV4ComposerDraft(workspacePath, undefined, "new", {
      text: "already edited",
      mode: "edit",
    });
    seedImportedSessionDraft({ workspacePath, sessionId: "new", reused: false });
    expect(readV4ComposerDraft(workspacePath, undefined, "new")).toMatchObject({
      text: "already edited",
      mode: "edit",
    });
    seedImportedSessionDraft({ workspacePath, sessionId: "history", reused: true });
    expect(readV4ComposerDraft(workspacePath, undefined, "history")).toBeNull();
  });

  beforeEach(() => {
    selectionServices.clear();
    prepareWorkspaceMock.mockReset();
    toastMock.mockReset();
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("task → draft 继承模型目录但 slashCommands 为空时重新拉取并写入 identity 桶", async () => {
    const workspacePath = "/workspace";
    const workspaceIdentity = "ssh://demo/workspace";
    useZCodeSessionStore
      .getState()
      .setConfigOptions(workspacePath, WORKSPACE_PRESENTATION, workspaceIdentity);
    prepareWorkspaceMock.mockResolvedValue({
      configOptions: WORKSPACE_PRESENTATION,
      slashCommands: CUSTOM_COMMANDS,
    });

    function Probe() {
      useDraftConfigControl({
        workspacePath,
        workspaceIdentity,
        provider: "glm",
        sessionId: null,
        modelSelectionView: null,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe));
    });

    await vi.waitFor(() => {
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .slashCommands,
      ).toEqual(CUSTOM_COMMANDS);
    });
    expect(prepareWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity, workspacePath }),
    );

    act(() => root.unmount());
  });

  it("打开已有 session 且 workspace slashCommands 为空时独立补水合", async () => {
    const workspacePath = "/known-workspace";
    useZCodeSessionStore.getState().setConfigOptions(workspacePath, WORKSPACE_PRESENTATION);
    prepareWorkspaceMock.mockResolvedValue({
      configOptions: WORKSPACE_PRESENTATION,
      slashCommands: CUSTOM_COMMANDS,
    });

    function Probe() {
      useDraftConfigControl({
        workspacePath,
        provider: "glm",
        sessionId: "session-known",
        modelSelectionView: null,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe));
    });

    await vi.waitFor(() => {
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).slashCommands,
      ).toEqual(CUSTOM_COMMANDS);
    });
    expect(prepareWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ workspacePath }));

    act(() => root.unmount());
  });

  it("打开已有 session 时保留已经水合的 workspace slashCommands", async () => {
    const workspacePath = "/hydrated-workspace";
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions(workspacePath, WORKSPACE_PRESENTATION);
    store.setSlashCommands(workspacePath, CUSTOM_COMMANDS);

    function Probe() {
      useDraftConfigControl({
        workspacePath,
        provider: "glm",
        sessionId: "session-known",
        modelSelectionView: null,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe));
    });

    expect(useZCodeSessionStore.getState().getWorkspaceState(workspacePath).slashCommands).toEqual(
      CUSTOM_COMMANDS,
    );
    expect(prepareWorkspaceMock).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("从 active task 新建草稿时不再从旧 workspace presentation 继承选择", async () => {
    const workspacePath = "/inherited-draft-workspace";
    const taskId = "task-custom-model";
    const inheritedOptions: ZCodeConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "custom-provider/gpt-5.6-sol",
        options: [{ value: "custom-provider/gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "yolo",
        options: [{ value: "yolo", name: "YOLO" }],
      },
      {
        id: "thought_level",
        name: "Thought",
        category: "thought_level",
        type: "select",
        currentValue: "max",
        options: [{ value: "max", name: "Max" }],
      },
    ];
    const store = useZCodeSessionStore.getState();
    store.setActiveTaskId(workspacePath, taskId);
    store.setTaskConfigOptions(workspacePath, taskId, inheritedOptions);
    store.startDraft(workspacePath, "glm");
    prepareWorkspaceMock.mockResolvedValue({
      configOptions: inheritedOptions,
      slashCommands: CUSTOM_COMMANDS,
    });

    let initialConfig: Partial<SessionConfigState> | undefined;
    function Probe() {
      const control = useDraftConfigControl({
        workspacePath,
        provider: "glm",
        sessionId: null,
        modelSelectionView: null,
      });
      initialConfig = control.resolveInitialDraftConfig();
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe));
    });

    // 旧 task presentation 不再是新 Composer 的选择来源；View 未到达时不初始化。
    expect(initialConfig).toBeUndefined();

    act(() => root.unmount());
  });

  it("active session 切入草稿时，View 未 Ready 不提前用旧 task 配置初始化", async () => {
    const workspacePath = "/inherited-draft-render-transition";
    const taskId = "task-custom-model";
    const inheritedOptions: ZCodeConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "custom-provider/gpt-5.6-sol",
        options: [{ value: "custom-provider/gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "yolo",
        options: [{ value: "yolo", name: "YOLO" }],
      },
      {
        id: "thought_level",
        name: "Thought",
        category: "thought_level",
        type: "select",
        currentValue: "max",
        options: [{ value: "max", name: "Max" }],
      },
    ];
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions(workspacePath, inheritedOptions);
    store.setActiveTaskId(workspacePath, taskId);
    store.setTaskConfigOptions(workspacePath, taskId, inheritedOptions);
    store.setSlashCommands(workspacePath, CUSTOM_COMMANDS);
    prepareWorkspaceMock.mockResolvedValue({
      configOptions: inheritedOptions,
      slashCommands: CUSTOM_COMMANDS,
    });

    const configsSeenDuringDraftRender: Array<Partial<SessionConfigState> | undefined> = [];
    function Probe({ sessionId }: { sessionId: string | null }) {
      const control = useDraftConfigControl({
        workspacePath,
        provider: "glm",
        sessionId,
        modelSelectionView: null,
      });
      if (sessionId === null) {
        configsSeenDuringDraftRender.push(control.resolveInitialDraftConfig());
      }
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe, { sessionId: taskId }));
    });

    act(() => {
      useZCodeSessionStore.getState().startDraft(workspacePath, "glm");
      root.render(createElement(Probe, { sessionId: null }));
    });

    expect(configsSeenDuringDraftRender[0]).toBeUndefined();

    act(() => root.unmount());
  });

  it("Registry revision 只影响有效选择，正文和模式编辑保留原意图，配置恢复后重新有效", async () => {
    const workspacePath = "/live-selection-invalidated";
    const firstView = modelSelectionView(1, ["old", "preferred"], "preferred");
    const nextView = modelSelectionView(2, ["preferred"], "preferred");
    useZCodeSessionStore.getState().setSlashCommands(workspacePath, CUSTOM_COMMANDS);
    useZCodeSessionStore.getState().setConfigOptions(workspacePath, WORKSPACE_PRESENTATION);

    let control: ReturnType<typeof useDraftConfigControl> | undefined;
    function Probe({ view }: { view: ModelSelectionView }) {
      control = useDraftConfigControl({
        workspacePath,
        provider: "glm",
        sessionId: null,
        modelSelectionView: view,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(Probe, { view: firstView }));
    });
    act(() => control!.handleDraftSelectModel("provider", "old"));
    expect(control!.draftConfig.modelSelection).toEqual({
      providerId: "provider",
      modelId: "old",
      options: { reasoningLevel: "high" },
    });

    await act(async () => {
      root.render(createElement(Probe, { view: nextView }));
    });

    expect(control!.draftConfig.modelSelection).toBeUndefined();
    expect(control!.resolveInitialDraftConfig()?.modelSelection).toBeUndefined();
    act(() => control!.updateComposerContent({ text: "保留原选择" }));
    act(() => control!.handleDraftSwitchMode("plan"));
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")).toMatchObject({
      mode: "build",
      planEnabled: true,
      text: "保留原选择",
      modelSelection: { providerId: "provider", modelId: "old" },
    });
    await act(async () => {
      root.render(createElement(Probe, { view: { ...firstView, revision: 3 } }));
    });
    expect(control!.draftConfig.modelSelection).toEqual({
      providerId: "provider",
      modelId: "old",
      options: { reasoningLevel: "high" },
    });
    expect(toastMock).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("有效选择只在接纳时写回，迟到接纳不能覆盖新选择或另一个 scope", async () => {
    const workspacePath = "/effective-selection-commit";
    const root = createRoot(installMinimalDom());
    const original = {
      providerId: "old-account",
      modelId: "model",
      options: { reasoningLevel: "high" },
    };
    const effective = { ...original, providerId: "new-account" };
    persistV4ComposerDraft(workspacePath, undefined, "a", {
      text: "hello",
      mode: "build",
      modelSelection: original,
    });
    const service: IModelSelectionService = {
      getView: async (input) => ({
        revision: 1,
        providers: [],
        effectiveSelection:
          input?.selection?.providerId === "old-account" ? effective : (input?.selection ?? null),
      }),
      onDidChange: () => ({ dispose: () => {} }),
    };
    let control: ReturnType<typeof useActualDraftConfigControl>;
    function Probe({ sessionId }: { sessionId: string }) {
      control = useActualDraftConfigControl({
        workspacePath,
        sessionId,
        sessionConfig: { mode: "build" },
        agentStartupAllowed: false,
        modelSelectionService: service,
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe, { sessionId: "a" })));
    expect(control!.draftConfig.modelSelection).toEqual(effective);
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.modelSelection).toEqual(original);
    // 对象属性顺序不属于 Selection 语义，协议/序列化重建可能改变顺序。
    const accepted = control!.captureAcceptedModelSelection({
      options: effective.options,
      modelId: effective.modelId,
      providerId: effective.providerId,
    });
    act(() => control!.updateComposerContent({ text: "新正文" }));
    act(() => accepted());
    expect(readV4ComposerDraft(workspacePath, undefined, "a")).toMatchObject({
      text: "新正文",
      modelSelection: effective,
    });
    const recommended = { ...effective, providerId: "account:bigmodel-start-plan" };
    const acceptRecommendation = control!.captureAcceptedModelSelection(recommended, effective);
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.modelSelection).toEqual(effective);
    act(() => acceptRecommendation());
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.modelSelection).toEqual(recommended);
    const staleAccepted = control!.captureAcceptedModelSelection(recommended);
    await act(async () => control!.handleDraftSelectModel("personal", "another"));
    act(() => staleAccepted());
    expect(readV4ComposerDraft(workspacePath, undefined, "a")?.modelSelection).toEqual({
      providerId: "personal",
      modelId: "another",
    });
    const oldScopeAccepted = control!.captureAcceptedModelSelection(
      control!.draftConfig.modelSelection!,
    );
    await act(async () => root.render(createElement(Probe, { sessionId: "b" })));
    act(() => oldScopeAccepted());
    expect(readV4ComposerDraft(workspacePath, undefined, "b")?.modelSelection).toBeUndefined();
    act(() => root.unmount());
  });

  it("Session 只初始化一次，用户未发送的 mode/model 不被迟到 Snapshot 覆盖", async () => {
    const workspacePath = "/session-draft-seed";
    const view = modelSelectionView(1, ["old", "new"], "old");
    const root = createRoot(installMinimalDom());
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({ config }: { config: Partial<SessionConfigState> | null }) {
      control = useDraftConfigControl({
        workspacePath,
        sessionId: "session",
        sessionConfig: config,
        agentStartupAllowed: false,
        modelSelectionView: view,
      });
      return null;
    }
    const config = { mode: "yolo", modelSelection: view.preferredSelection! };
    await act(async () => {
      root.render(createElement(Probe, { config }));
    });
    expect(control!.draftConfig).toMatchObject(config);
    act(() => {
      control!.handleDraftSwitchMode("edit");
      control!.handleDraftSelectModel("provider", "new");
    });
    await act(async () => {
      root.render(createElement(Probe, { config: { ...config } }));
    });
    expect(control!.draftConfig).toMatchObject({
      mode: "edit",
      modelSelection: { modelId: "new" },
    });
    expect(readV4ComposerDraft(workspacePath, undefined, "session")).toMatchObject({
      text: "",
      mode: "edit",
      modelSelection: { modelId: "new" },
    });
    act(() => root.unmount());
  });

  it("旧文本草稿等 Session 到达后只补新字段；Todo70 未绑定结果不会用 preferred 填满", async () => {
    const workspacePath = "/old-text-draft";
    const root = createRoot(installMinimalDom());
    persistV4ComposerDraft(workspacePath, undefined, "session", { text: "未发送正文" });
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({ config }: { config: Partial<SessionConfigState> | null }) {
      control = useDraftConfigControl({
        workspacePath,
        sessionId: "session",
        sessionConfig: config,
        agentStartupAllowed: false,
        modelSelectionView: modelSelectionView(1, ["old"], "old"),
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe, { config: null }));
    });
    expect(readV4ComposerDraft(workspacePath, undefined, "session")?.mode).toBeUndefined();
    await act(async () => {
      root.render(createElement(Probe, { config: { mode: "build" } }));
    });
    expect(control!.draftConfig.modelSelection).toBeUndefined();
    expect(readV4ComposerDraft(workspacePath, undefined, "session")).toMatchObject({
      text: "未发送正文",
      mode: "build",
    });
    await act(async () => {
      root.render(
        createElement(Probe, {
          config: {
            mode: "yolo",
            modelSelection: modelSelectionView(1, ["old"], "old").preferredSelection!,
          },
        }),
      );
    });
    expect(control!.draftConfig).toMatchObject({ mode: "build" });
    expect(control!.draftConfig.modelSelection).toBeUndefined();
    act(() => root.unmount());
  });

  it("新 Root 继承最近接纳的权限，菜单编辑与旧 Snapshot 不覆盖独立草稿", async () => {
    const workspacePath = "/recent-mode";
    const root = createRoot(installMinimalDom());
    const view = modelSelectionView(1, ["model"], "model");
    window.localStorage.setItem(
      `zcode-model-selection-recent-v1:${workspacePath}`,
      JSON.stringify({ modelSelection: view.preferredSelection, mode: "yolo" }),
    );
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({ sessionId }: { sessionId: string | null }) {
      control = useDraftConfigControl({
        workspacePath,
        sessionId,
        sessionConfig: { mode: "build", modelSelection: view.preferredSelection },
        agentStartupAllowed: false,
        modelSelectionView: view,
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe, { sessionId: null })));
    expect(control!.draftConfig.mode).toBe("yolo");
    act(() => control!.handleDraftSwitchMode("plan"));
    await act(async () => root.render(createElement(Probe, { sessionId: "session" })));
    expect(control!.draftConfig.mode).toBe("build");
    act(() => control!.handleDraftSwitchMode("edit"));
    await act(async () => root.render(createElement(Probe, { sessionId: null })));
    expect(control!.draftConfig).toMatchObject({ mode: "yolo", planEnabled: true });
    await act(async () => root.render(createElement(Probe, { sessionId: "session" })));
    expect(control!.draftConfig.mode).toBe("edit");
    expect(
      JSON.parse(window.localStorage.getItem(`zcode-model-selection-recent-v1:${workspacePath}`)!),
    ).toMatchObject({ mode: "yolo" });
    act(() => root.unmount());
  });

  it("新草稿先保留 Recent 原意图，再交给当前 View 解析，不能在初始化时丢掉旧账号", async () => {
    const workspacePath = "/recent-account-intent";
    const root = createRoot(installMinimalDom());
    const original = {
      providerId: "old-account",
      modelId: "same",
      options: { reasoningLevel: "high" },
    };
    const effective = { ...original, providerId: "provider" };
    captureComposerRecentSubmission(workspacePath, { modelSelection: original, mode: "build" })();
    const service: IModelSelectionService = {
      getView: async (input) => ({
        ...modelSelectionView(1, ["same"], "same"),
        ...(input ? { effectiveSelection: input.selection ? effective : null } : {}),
      }),
      onDidChange: () => ({ dispose() {} }),
    };
    let control: ReturnType<typeof useActualDraftConfigControl>;
    function Probe() {
      control = useActualDraftConfigControl({
        workspacePath,
        sessionId: null,
        agentStartupAllowed: false,
        modelSelectionService: service,
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(control!.draftConfig.modelSelection).toEqual(effective);
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")?.modelSelection).toEqual(
      original,
    );
    act(() => root.unmount());
  });

  it("Reasoning 失效只清档位，loading 不清选择，重挂载不补默认", async () => {
    const workspacePath = "/persisted-invalid-reasoning";
    const container = installMinimalDom();
    persistV4ComposerDraft(workspacePath, undefined, "session", {
      text: "draft",
      mode: "plan",
      modelSelection: {
        providerId: "provider",
        modelId: "old",
        options: { reasoningLevel: "deleted" },
      },
    });
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({ view }: { view: ModelSelectionView | null }) {
      control = useDraftConfigControl({
        workspacePath,
        sessionId: "session",
        sessionConfig: { mode: "build" },
        agentStartupAllowed: false,
        modelSelectionView: view,
      });
      return null;
    }
    let root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { view: null }));
    });
    expect(control!.draftConfig.modelSelection?.options?.reasoningLevel).toBe("deleted");
    const view = modelSelectionView(1, ["old"], "old");
    await act(async () => {
      root.render(createElement(Probe, { view }));
    });
    expect(control!.draftConfig.modelSelection).toEqual({ providerId: "provider", modelId: "old" });
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { view }));
    });
    expect(control!.draftConfig.modelSelection).toEqual({ providerId: "provider", modelId: "old" });
    expect(control!.draftConfig).toMatchObject({ mode: "build", planEnabled: true });
    expect(
      readV4ComposerDraft(workspacePath, undefined, "session")?.modelSelection?.options
        ?.reasoningLevel,
    ).toBe("deleted");
    expect(toastMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("延迟 Session seed 也校验档位，正文保存与选模共享完整草稿且 scope 隔离", async () => {
    const workspacePath = "/delayed-session";
    const root = createRoot(installMinimalDom());
    const view = modelSelectionView(1, ["old", "new"], "new");
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({
      sessionId,
      config,
    }: {
      sessionId: string;
      config: Partial<SessionConfigState> | null;
    }) {
      control = useDraftConfigControl({
        workspacePath,
        workspaceIdentity: "ssh://demo/workspace",
        sessionId,
        sessionConfig: config,
        agentStartupAllowed: false,
        modelSelectionView: view,
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "a", config: null }));
    });
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: "a",
          config: {
            mode: "yolo",
            modelSelection: {
              providerId: "provider",
              modelId: "old",
              options: { reasoningLevel: "deleted" },
            },
          },
        }),
      );
    });
    expect(control!.draftConfig.modelSelection).toEqual({ providerId: "provider", modelId: "old" });
    act(() => {
      control!.updateComposerContent({ text: "草稿 A" });
      control!.handleDraftSelectModel("provider", "new");
    });
    const staleContentCallback = control!.updateComposerContent;
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "b", config: { mode: "plan" } }));
    });
    act(() => staleContentCallback({ text: "迟到 A" }));
    expect(control!.composerDraft).toMatchObject({ text: "", mode: "build", planEnabled: true });
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "a", config: { mode: "build" } }));
    });
    expect(control!.composerDraft).toMatchObject({
      text: "草稿 A",
      mode: "yolo",
      modelSelection: {
        providerId: "provider",
        modelId: "new",
      },
    });
    expect(readV4ComposerDraft(workspacePath, undefined, "a")).toBeNull();
    act(() => root.unmount());
  });

  it("新任务创建 Session 时先转移完整 Draft，再删除 Root scope", async () => {
    const workspacePath = "/promote-composer-draft";
    const root = createRoot(installMinimalDom());
    const view = modelSelectionView(1, ["model"], "model");
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe() {
      control = useDraftConfigControl({
        workspacePath,
        sessionId: null,
        agentStartupAllowed: false,
        modelSelectionView: view,
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    act(() => {
      control!.updateComposerContent({ text: "等待接纳的正文" });
      control!.handleDraftSwitchMode("yolo");
      control!.handleDraftSelectModel("provider", "model");
      control!.promoteComposerDraft("created-session");
    });
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")).toBeNull();
    expect(readV4ComposerDraft(workspacePath, undefined, "created-session")).toMatchObject({
      text: "等待接纳的正文",
      mode: "yolo",
      modelSelection: {
        providerId: "provider",
        modelId: "model",
      },
    });
    act(() => root.unmount());
  });

  it("目标 Session scope 写盘失败时保留 Root Draft", async () => {
    const workspacePath = "/promote-write-failure";
    const root = createRoot(installMinimalDom());
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe() {
      control = useDraftConfigControl({
        workspacePath,
        sessionId: null,
        agentStartupAllowed: false,
        modelSelectionView: modelSelectionView(1, ["model"], "model"),
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    act(() => control!.updateComposerContent({ text: "必须保留" }));
    persistV4ComposerDraft(workspacePath, undefined, "__draft__", control!.composerDraft);
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")?.text).toBe("必须保留");
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const failedWrites = vi.fn(() => {
      throw new Error("quota");
    });
    window.localStorage.setItem = failedWrites;
    act(() => control!.promoteComposerDraft("created-session"));
    window.localStorage.setItem = originalSetItem;
    expect(failedWrites).toHaveBeenCalledTimes(1);
    expect(readV4ComposerDraft(workspacePath, undefined, "__draft__")?.text).toBe("必须保留");
    expect(readV4ComposerDraft(workspacePath, undefined, "created-session")).toBeNull();
    act(() => root.unmount());
  });
  it("PA158 授权按 scope 消费一次，保留 Plan/草稿；撤回编辑不重放旧授权", async () => {
    const root = createRoot(installMinimalDom());
    const workspacePath = "/permission-grant";
    persistV4ComposerDraft(workspacePath, undefined, "s", {
      text: "draft",
      mode: "edit",
      planEnabled: true,
    });
    let control: ReturnType<typeof useDraftConfigControl>;
    function Probe({ sessionId }: { sessionId: string }) {
      control = useDraftConfigControl({
        workspacePath,
        sessionId,
        sessionConfig:
          sessionId === "s"
            ? { mode: "yolo", planEnabled: false, permissionGrant: { interactionId: "p" } }
            : { mode: "build" },
        modelSelectionView: null,
        agentStartupAllowed: false,
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe, { sessionId: "s" })));
    expect(control!.composerDraft).toMatchObject({
      text: "draft",
      mode: "yolo",
      planEnabled: true,
    });
    act(() => control!.handleDraftSwitchMode("build"));
    await act(async () => root.render(createElement(Probe, { sessionId: "s" })));
    expect(control!.composerDraft.mode).toBe("build");
    act(() =>
      control!.replaceComposerDraft({ text: "later queue", mode: "edit", planEnabled: false }),
    );
    expect(control!.composerDraft).toMatchObject({
      text: "later queue",
      mode: "edit",
      planEnabled: false,
      lastPermissionGrantId: "p",
    });
    await act(async () => root.render(createElement(Probe, { sessionId: "other" })));
    expect(control!.composerDraft.mode).toBe("build");
    await act(async () => root.render(createElement(Probe, { sessionId: "s" })));
    expect(control!.composerDraft.mode).toBe("edit");
    act(() => root.unmount());
  });
});
