// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";

const getPluginReferenceCatalog = vi.hoisted(() => vi.fn());
const resolveSuggestedPluginReference = vi.hoisted(() => vi.fn());
const installPlugin = vi.hoisted(() => vi.fn());
const setPluginEnabled = vi.hoisted(() => vi.fn());
const cancelPluginOperation = vi.hoisted(() => vi.fn());
const onDynamicPluginOperationProgress = vi.hoisted(() => vi.fn());
const invalidateDraftSession = vi.hoisted(() => vi.fn());
const listClientScenes = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const reportTelemetryEvent = vi.hoisted(() => vi.fn());
const dismissToast = vi.hoisted(() => vi.fn());
const pluginOperationProgressListeners = new Map<
  string,
  Set<(event: { operationId: string; state: "refreshing" }) => void>
>();

function emitPluginOperationProgress(operationId: string) {
  for (const listener of pluginOperationProgressListeners.get(operationId) ?? []) {
    listener({ operationId, state: "refreshing" });
  }
}

function render(ui: ReactNode) {
  return renderWithTestingLibrary(
    createElement(
      SWRConfig,
      {
        value: {
          provider: () => new Map(),
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        },
      },
      ui,
    ),
  );
}

vi.mock("@/components/ui/toast.js", () => ({ dismissToast, toast }));

// 推荐容器新增共享偏好读取；单测沿用独立 hook mock，避免依赖真实 ServiceProvider。
vi.mock("@/hooks/useSettingService.js", () => {
  const value = {
    settings: { proactiveSuggestionsEnabled: false, onboardingOccupation: null },
    update: vi.fn(),
  };
  return { useSettings: () => value };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ reportTelemetryEvent }),
}));

vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: invalidateDraftSession,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    warn: loggerWarn,
  },
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => {
  // 生产 hook 会 memoize resolution/services；测试也必须保持引用稳定，否则 effect setState 后会被假服务引用反复触发。
  const services = {
    clientScenesService: { list: listClientScenes },
    pluginManagementService: {
      cancelPluginOperation,
      getPluginReferenceCatalog,
      installPlugin,
      onDynamicPluginOperationProgress,
      resolveSuggestedPluginReference,
      setPluginEnabled,
    },
    zcodeSessionService: {},
  };
  return {
    useWorkspaceServicesResolution: (
      _workspacePath: string,
      preferredRemoteSessionId?: string,
    ) => ({
      services,
      remoteSessionId: preferredRemoteSessionId ?? null,
      isRemoteTarget: false,
      connectionKind: "local-ready",
      rpcReady: true,
    }),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: { pluginLabel?: string; error?: string }) =>
        id === "chat.draft.suggestedPrompt.pluginFlow.installConfirmation"
          ? `安装${values?.pluginLabel ?? ""}插件`
          : id === "chat.draft.suggestedPrompt.pluginFlow.enableConfirmation"
            ? `开启${values?.pluginLabel ?? ""}插件`
            : id === "chat.draft.suggestedPrompt.pluginFlow.installFailureToast"
              ? `${values?.pluginLabel ?? ""} 安装失败：${values?.error ?? ""}`
              : ({
                  "chat.draft.suggestedPrompt.pluginFlow.installing": "正在安装插件…",
                  "chat.draft.suggestedPrompt.pluginFlow.enabling": "正在启用插件…",
                  "chat.draft.suggestedPrompt.pluginFlow.checking": "正在检查插件状态…",
                  "chat.draft.suggestedPrompt.pluginFlow.confirm": "确认",
                  "chat.draft.suggestedPrompt.pluginFlow.installSucceeded": "安装成功",
                  "chat.draft.suggestedPrompt.pluginFlow.installFailed": "插件安装失败",
                  "chat.draft.suggestedPrompt.pluginFlow.installTimedOut": "安装超时",
                  "chat.draft.suggestedPrompt.pluginFlow.installReturnedEmpty": "未返回已安装插件",
                  "chat.draft.suggestedPrompt.pluginFlow.enableSucceeded": "开启成功",
                  "chat.draft.suggestedPrompt.pluginFlow.enableFailed": "插件开启失败",
                }[id] ?? id),
    },
  }),
}));

const plainPrompt = "检查当前工作区近 7 天的 Git commit，概括主要改动并指出潜在风险。";
const pluginPrompt = "根据当前工作区内容制作一份 PDF 文档。";
const automationsPrompt = "打开自动化面板。";
const offPeakPrompt = "打开闲时任务面板。";
const plainLabel = "检查 commit";
const pluginLabel = "制作 PDF";
const automationsLabel = "自动化";
const offPeakLabel = "闲时任务";

async function applyPendingComposerTextInsert(workspacePath: string, workspaceIdentity?: string) {
  const request = await waitFor(() => {
    const current = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest;
    if (!current) throw new Error("Composer insert request is not ready");
    return current;
  });
  act(() => {
    useZCodeSessionStore
      .getState()
      .clearComposerTextInsertRequest(workspacePath, request.requestId, workspaceIdentity);
  });
  return request;
}

const clientScenesResponse = {
  code: 0,
  msg: "",
  data: [
    {
      namespace: "zcode",
      scene: "draft-suggestion",
      options: {
        prompts: {
          id: "prompt",
          type: "prompt",
          contents: { cn: "提示词", en: "Prompt" },
          prompts: { cn: "", en: "" },
          items: [
            {
              id: "recent-commits",
              type: "prompt",
              contents: { cn: plainPrompt, en: "Check the workspace commits." },
              descs: { cn: "", en: "" },
              labels: { cn: plainLabel, en: "Check commits" },
              on_finish: null,
              img: null,
              share_urls: {},
            },
            {
              id: "create-pdf",
              type: "prompt",
              contents: {
                cn: pluginPrompt,
                en: "Create a PDF from the workspace.",
              },
              descs: { cn: "", en: "" },
              labels: { cn: pluginLabel, en: "Create PDF" },
              on_finish: null,
              img: null,
              share_urls: {},
              defaults: { plugin: ["document-skills"] },
            },
            {
              id: "open-automations",
              type: "prompt",
              contents: {
                cn: automationsPrompt,
                en: "Open Automations.",
              },
              descs: { cn: "", en: "" },
              labels: { cn: automationsLabel, en: "Automations" },
              on_finish: "UNKNOWN:ACTION, NAVIGATE:AUTOMATIONS",
              img: null,
              share_urls: {},
            },
            {
              id: "open-offpeak",
              type: "prompt",
              contents: {
                cn: offPeakPrompt,
                en: "Open Idle-time automations.",
              },
              descs: { cn: "", en: "" },
              labels: { cn: offPeakLabel, en: "Idle-time" },
              on_finish: "NAVIGATE:AUTOMATIONS, NAVIGATE:AUTOMATIONS:OFFPEAK",
              img: null,
              share_urls: {},
            },
          ],
          refer: "",
          cascades: {},
        },
        plugin: {
          id: "plugin",
          type: "plugin",
          contents: { cn: "插件", en: "Plugin" },
          prompts: { cn: "", en: "" },
          items: [
            {
              id: "document-skills",
              type: "plugin",
              contents: {
                cn: "document-skills@zcode-plugins-official",
                en: "document-skills@zcode-plugins-official",
              },
              descs: { cn: "", en: "" },
              labels: { cn: "文档技能", en: "Document skills" },
              on_finish: null,
              img: null,
              share_urls: {},
            },
          ],
          refer: "",
          cascades: {},
        },
      },
      created_at: 1,
      updated_at: 2,
    },
  ],
};

describe("ConversationDraftSuggestedPromptsContainer", () => {
  beforeEach(() => {
    getPluginReferenceCatalog.mockReset();
    getPluginReferenceCatalog.mockResolvedValue({ authority: "workspace", plugins: [] });
    resolveSuggestedPluginReference.mockReset();
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "unavailable",
      diagnostics: [],
    });
    installPlugin.mockReset();
    installPlugin.mockResolvedValue({
      dependencyClosure: ["document-skills@zcode-plugins-official"],
      installedPlugins: [
        {
          id: "document-skills@zcode-plugins-official",
          name: "document-skills",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
        },
      ],
      diagnostics: [],
    });
    setPluginEnabled.mockReset();
    setPluginEnabled.mockResolvedValue({ enabled: true, plugin: {} });
    cancelPluginOperation.mockReset();
    cancelPluginOperation.mockResolvedValue({ operationId: "operation", cancelled: true });
    pluginOperationProgressListeners.clear();
    onDynamicPluginOperationProgress.mockReset();
    onDynamicPluginOperationProgress.mockImplementation(
      (operationId: string) =>
        (listener: (event: { operationId: string; state: "refreshing" }) => void) => {
          const listeners =
            pluginOperationProgressListeners.get(operationId) ??
            new Set<(event: { operationId: string; state: "refreshing" }) => void>();
          listeners.add(listener);
          pluginOperationProgressListeners.set(operationId, listeners);
          return {
            dispose() {
              listeners.delete(listener);
              if (listeners.size === 0) pluginOperationProgressListeners.delete(operationId);
            },
          };
        },
    );
    invalidateDraftSession.mockReset();
    invalidateDraftSession.mockResolvedValue(undefined);
    listClientScenes.mockReset();
    listClientScenes.mockResolvedValue(clientScenesResponse);
    loggerWarn.mockReset();
    toast.mockReset();
    let nextToastId = 1;
    toast.mockImplementation(() => nextToastId++);
    dismissToast.mockReset();
    reportTelemetryEvent.mockReset();
    reportTelemetryEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("reserves an in-flow slot for the async list below the composer", async () => {
    const view = render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        className: "mt-3",
        workspacePath: "/tmp/suggested-prompt-layout",
      }),
    );

    await screen.findByRole("button", { name: plainLabel });
    const slot = view.container.firstElementChild;

    expect(slot?.getAttribute("data-v4-draft-suggested-prompts-slot")).toBe("true");
    expect(slot?.classList.contains("h-8")).toBe(true);
    expect(slot?.classList.contains("mt-3")).toBe(true);
    expect(slot?.classList.contains("absolute")).toBe(false);
    expect(slot?.classList.contains("top-full")).toBe(false);
  });

  it("keeps the in-flow slot mounted while the async list is empty", () => {
    listClientScenes.mockImplementation(() => new Promise(() => {}));

    const view = render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath: "/tmp/suggested-prompt-empty-slot",
      }),
    );

    const slot = view.container.firstElementChild;
    expect(slot?.getAttribute("data-v4-draft-suggested-prompts-slot")).toBe("true");
    expect(slot?.classList.contains("h-8")).toBe(true);
    expect(slot?.childElementCount).toBe(0);
  });

  it("keeps the list empty when client scenes only has the legacy ai-writing scene", async () => {
    listClientScenes.mockResolvedValue({
      code: 0,
      msg: "",
      data: [{ ...clientScenesResponse.data[0], scene: "ai-writing" }],
    });

    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath: "/tmp/suggested-prompt-scenes",
      }),
    );

    await waitFor(() => expect(listClientScenes).toHaveBeenCalledOnce());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the list empty and logs a warning when client scenes fails", async () => {
    listClientScenes.mockRejectedValue(new Error("offline"));

    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath: "/tmp/suggested-prompt-scenes-error",
      }),
    );

    await waitFor(() => expect(loggerWarn).toHaveBeenCalledOnce());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("filters Automations navigation prompts when the navigation capability is absent", async () => {
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath: "/tmp/suggested-prompt-no-automations",
      }),
    );

    await screen.findByRole("button", { name: plainLabel });
    expect(screen.queryByRole("button", { name: automationsLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: offPeakLabel })).toBeNull();
  });

  it("opens Automations without prefilling or sending", async () => {
    const workspacePath = "/tmp/suggested-prompt-automations";
    const onOpenAutomations = vi.fn();
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        onOpenAutomations,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: automationsLabel }));

    expect(onOpenAutomations).toHaveBeenCalledOnce();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toBeNull();
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("reports a Desktop template click before plugin resolution", async () => {
    const workspacePath = "/tmp/suggested-prompt-desktop-telemetry";
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        isDesktop: true,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    expect(reportTelemetryEvent).toHaveBeenCalledOnce();
    expect(reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        elementName: "prompt_template_ck",
        eventRegion: "app.session",
        eventType: "ck",
        eventText: pluginLabel,
        eventExtraDetail: {
          template_id: "create-pdf",
          template_prompt: pluginPrompt,
        },
      }),
    );
  });

  it("does not report template clicks on non-Desktop surfaces", async () => {
    const workspacePath = "/tmp/suggested-prompt-web-telemetry";
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        isDesktop: false,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: plainLabel }));

    expect(reportTelemetryEvent).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest
          ?.text,
      ).toBe(plainPrompt),
    );
  });

  it("opens the Idle-time Automations tab without prefilling or navigating twice", async () => {
    const workspacePath = "/tmp/suggested-prompt-offpeak";
    const onOpenAutomations = vi.fn();
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        onOpenAutomations,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: offPeakLabel }));

    expect(onOpenAutomations).toHaveBeenCalledOnce();
    expect(onOpenAutomations).toHaveBeenCalledWith("idle");
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toBeNull();
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("replaces the workspace draft with the plain commit prompt without sending", async () => {
    const workspacePath = "/tmp/suggested-prompt-plain";
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: plainLabel }));

    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toEqual({
        requestId: 1,
        text: plainPrompt,
      }),
    );
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("waits for trusted resolution, then inserts Plugin and prompt together once", async () => {
    const workspacePath = "/tmp/suggested-prompt-plugin";
    const workspaceIdentity = "ssh://host/tmp/suggested-prompt-plugin";
    let settleResolution!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockReturnValue(
      new Promise((resolve) => {
        settleResolution = resolve;
      }),
    );
    const insertSpy = vi.spyOn(useZCodeSessionStore.getState(), "requestComposerTextInsert");
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        workspaceIdentity,
        remoteSessionId: "remote-runtime",
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    await waitFor(() => expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce());
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .composerTextInsertRequest,
    ).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(screen.queryByText("正在检查插件状态…")).toBeNull();
    expect(document.querySelector('[data-draft-suggested-plugin-popover="progress"]')).toBeNull();

    act(() => {
      settleResolution({
        stableId: "document-skills@zcode-plugins-official",
        status: "ready",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        icon: "https://cdn.example/document-skills.svg",
        diagnostics: [],
      });
    });

    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .composerTextInsertRequest,
      ).toEqual({
        requestId: 1,
        text: `[@文档技能](plugin://document-skills@zcode-plugins-official) ${pluginPrompt}`,
        mention: expect.objectContaining({
          id: "plugin:document-skills@zcode-plugins-official",
          category: "plugins",
          value: "document-skills@zcode-plugins-official",
          data: {
            pluginId: "document-skills@zcode-plugins-official",
            icon: "https://cdn.example/document-skills.svg",
          },
        }),
      }),
    );
    expect(insertSpy).toHaveBeenCalledOnce();
    expect(resolveSuggestedPluginReference).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
      remoteSessionId: "remote-runtime",
      stableId: "document-skills@zcode-plugins-official",
      operationId: expect.any(String),
      clientMode: "desktop-continuous",
      deliveryKind: "desktop-continuous",
    });
    expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce();
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
    expect(invalidateDraftSession).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("uses the default Plugin icon when trusted resolution has no listing icon", async () => {
    const workspacePath = "/tmp/suggested-prompt-plugin-icon-fallback";
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "ready",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    render(createElement(ConversationDraftSuggestedPromptsContainer, { workspacePath }));

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest
          ?.mention?.data,
      ).toEqual({ pluginId: "document-skills@zcode-plugins-official" }),
    );
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("keeps the plain PDF prompt when trusted resolution fails", async () => {
    const workspacePath = "/tmp/suggested-prompt-fallback";
    resolveSuggestedPluginReference.mockRejectedValue(new Error("disconnected"));
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toEqual({
        requestId: 1,
        text: pluginPrompt,
      }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("rejects an actionable result that does not attest the canonical official source", async () => {
    const workspacePath = "/tmp/suggested-prompt-untrusted-result";
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "ready",
      marketplace: "personal",
      pluginName: "document-skills",
      diagnostics: [],
    });
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    await waitFor(() => expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce());
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toEqual({ requestId: 1, text: pluginPrompt });
    expect(toast).not.toHaveBeenCalled();
  });

  it("drops delayed Plugin resolution after the Composer revision changes", async () => {
    const workspacePath = "/tmp/suggested-prompt-plugin-user-edit";
    let settleResolution!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockReturnValue(
      new Promise((resolve) => {
        settleResolution = resolve;
      }),
    );
    render(createElement(ConversationDraftSuggestedPromptsContainer, { workspacePath }));

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    await waitFor(() => expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce());
    expect(toast).not.toHaveBeenCalled();
    await act(async () => {
      advanceComposerDraftRevision(workspacePath);
      settleResolution({
        stableId: "document-skills@zcode-plugins-official",
        status: "missing",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      });
    });

    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    expect(dismissToast).not.toHaveBeenCalled();
  });

  it("installs a refreshed missing candidate in User scope, then prepends the chip", async () => {
    const workspacePath = "/tmp/suggested-prompt-missing";
    const workspaceIdentity = "ssh://host/tmp/suggested-prompt-missing";
    resolveSuggestedPluginReference
      .mockResolvedValueOnce({
        stableId: "document-skills@zcode-plugins-official",
        status: "missing",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        stableId: "document-skills@zcode-plugins-official",
        status: "ready",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        icon: "https://cdn.example/document-skills.svg",
        diagnostics: [],
      });
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        workspaceIdentity,
        remoteSessionId: "remote-runtime",
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .composerTextInsertRequest,
    ).toBeNull();

    expect(await applyPendingComposerTextInsert(workspacePath, workspaceIdentity)).toEqual({
      requestId: 1,
      text: pluginPrompt,
    });
    const installAction = await screen.findByRole("button", { name: "确认" });
    const confirmationPopover = document.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-popover="confirmation"]',
    );
    expect(confirmationPopover?.getAttribute("data-anchor-item-id")).toBe("create-pdf");
    expect(confirmationPopover?.textContent).toContain("安装文档技能插件");
    expect(installPlugin).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(installAction);

    await waitFor(() =>
      expect(installPlugin).toHaveBeenCalledWith({
        workspacePath,
        workspaceIdentity,
        remoteSessionId: "remote-runtime",
        pluginName: "document-skills",
        marketplace: "zcode-plugins-official",
        scope: "user",
        operationId: expect.any(String),
      }),
    );
    expect(await screen.findByText("正在安装插件…")).not.toBeNull();
    expect(
      document.querySelector('[data-draft-suggested-plugin-popover="progress"]'),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .composerTextInsertRequest,
      ).toEqual(
        expect.objectContaining({
          requestId: 2,
          mode: "prepend-if-missing",
        }),
      ),
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .composerTextInsertRequest?.mention?.data,
    ).toEqual({
      pluginId: "document-skills@zcode-plugins-official",
      icon: "https://cdn.example/document-skills.svg",
    });
    expect(screen.queryByText("安装成功")).toBeNull();
    vi.useFakeTimers();
    try {
      await act(async () => {
        useZCodeSessionStore
          .getState()
          .clearComposerTextInsertRequest(workspacePath, 2, workspaceIdentity);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("安装成功")).not.toBeNull();
      expect(
        document.querySelector('[data-draft-suggested-plugin-popover="success"]'),
      ).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1_999);
        await Promise.resolve();
      });
      expect(screen.getByText("安装成功")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(screen.queryByText("安装成功")).toBeNull();
      expect(toast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    expect(invalidateDraftSession).toHaveBeenCalledOnce();
    expect(resolveSuggestedPluginReference).toHaveBeenCalledTimes(2);
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("keeps one Popover from missing-plugin refresh loading through confirmation", async () => {
    const workspacePath = "/tmp/suggested-prompt-stable-popover-anchor";
    let settleResolution!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockReturnValue(
      new Promise((resolve) => {
        settleResolution = resolve;
      }),
    );
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    await waitFor(() => expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce());
    const operationId = resolveSuggestedPluginReference.mock.calls[0]?.[0].operationId as string;
    act(() => emitPluginOperationProgress(operationId));

    expect(await screen.findByText("正在检查插件状态…")).not.toBeNull();
    const loadingPopover = document.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-popover="progress"]',
    );
    expect(loadingPopover?.getAttribute("data-anchor-item-id")).toBe("create-pdf");
    expect(document.querySelectorAll("[data-draft-suggested-plugin-popover]")).toHaveLength(1);

    act(() => {
      settleResolution({
        stableId: "document-skills@zcode-plugins-official",
        status: "missing",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      });
    });
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toEqual({ requestId: 1, text: pluginPrompt }),
    );
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();

    act(() => {
      useZCodeSessionStore.getState().clearComposerTextInsertRequest(workspacePath, 1);
    });
    expect(await screen.findByRole("button", { name: "确认" })).not.toBeNull();
    const confirmationPopover = document.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-popover="confirmation"]',
    );
    expect(confirmationPopover).toBe(loadingPopover);
    expect(document.querySelectorAll("[data-draft-suggested-plugin-popover]")).toHaveLength(1);
  });

  it("enables an installed disabled Plugin before inserting the chip", async () => {
    const workspacePath = "/tmp/suggested-prompt-disabled";
    resolveSuggestedPluginReference
      .mockResolvedValueOnce({
        stableId: "document-skills@zcode-plugins-official",
        status: "disabled",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        stableId: "document-skills@zcode-plugins-official",
        status: "ready",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        icon: "https://cdn.example/document-skills.svg",
        diagnostics: [],
      });
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toEqual({ requestId: 1, text: pluginPrompt }),
    );
    expect(await screen.findByText("正在检查插件状态…")).not.toBeNull();
    const checkingPopover = document.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-popover="progress"]',
    );
    expect(document.querySelectorAll("[data-draft-suggested-plugin-popover]")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    act(() => {
      useZCodeSessionStore.getState().clearComposerTextInsertRequest(workspacePath, 1);
    });
    const enableAction = await screen.findByRole("button", { name: "确认" });
    const confirmationPopover = document.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-popover="confirmation"]',
    );
    expect(confirmationPopover).toBe(checkingPopover);
    expect(confirmationPopover?.getAttribute("data-anchor-item-id")).toBe("create-pdf");
    expect(confirmationPopover?.textContent).toContain("开启文档技能插件");
    expect(toast).not.toHaveBeenCalled();
    fireEvent.click(enableAction);

    await waitFor(() =>
      expect(setPluginEnabled).toHaveBeenCalledWith({
        workspacePath,
        pluginId: "document-skills@zcode-plugins-official",
        enabled: true,
        operationId: expect.any(String),
      }),
    );
    expect(await screen.findByText("正在启用插件…")).not.toBeNull();
    expect(
      document.querySelector('[data-draft-suggested-plugin-popover="progress"]'),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest
          ?.requestId,
      ).toBe(2),
    );
    expect(screen.queryByText("安装成功")).toBeNull();
    act(() => {
      useZCodeSessionStore.getState().clearComposerTextInsertRequest(workspacePath, 2);
    });
    expect(screen.queryByText("安装成功")).toBeNull();
    expect(await screen.findByText("开启成功")).not.toBeNull();
    expect(
      document.querySelector('[data-draft-suggested-plugin-popover="success"]'),
    ).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("replaces the persistent enablement Popover with failure and never calls toast", async () => {
    const workspacePath = "/tmp/suggested-prompt-enable-failed";
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "disabled",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    setPluginEnabled.mockRejectedValue(new Error("enable failed"));
    render(createElement(ConversationDraftSuggestedPromptsContainer, { workspacePath }));

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    await applyPendingComposerTextInsert(workspacePath);
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));

    expect(await screen.findByText("正在启用插件…")).not.toBeNull();
    expect(await screen.findByText("插件开启失败")).not.toBeNull();
    expect(document.querySelector('[data-draft-suggested-plugin-popover="error"]')).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(["missing", "disabled"] as const)(
    "keeps a %s Plugin confirmation open without a timeout and cancels it on outside pointer down",
    async (status) => {
      const workspacePath = `/tmp/suggested-prompt-${status}-confirmation-outside`;
      resolveSuggestedPluginReference.mockResolvedValue({
        stableId: "document-skills@zcode-plugins-official",
        status,
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      });
      render(
        createElement(ConversationDraftSuggestedPromptsContainer, {
          workspacePath,
        }),
      );
      await screen.findByRole("button", { name: pluginLabel });
      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByRole("button", { name: pluginLabel }));
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        const plainRequest = useZCodeSessionStore
          .getState()
          .getWorkspaceState(workspacePath).composerTextInsertRequest;
        expect(plainRequest).toEqual({ requestId: 1, text: pluginPrompt });
        act(() => {
          useZCodeSessionStore
            .getState()
            .clearComposerTextInsertRequest(workspacePath, plainRequest!.requestId);
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(60_000);
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(installPlugin).not.toHaveBeenCalled();
        expect(setPluginEnabled).not.toHaveBeenCalled();
        expect(cancelPluginOperation).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();

        fireEvent.pointerDown(document.body);
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(cancelPluginOperation).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
        expect(toast).not.toHaveBeenCalled();
        expect(
          useZCodeSessionStore.getState().getWorkspaceState(workspacePath)
            .composerTextInsertRequest,
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("closes a confirmation and still applies the recommendation clicked outside it", async () => {
    const workspacePath = "/tmp/suggested-prompt-confirmation-outside-recommendation";
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "missing",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    render(createElement(ConversationDraftSuggestedPromptsContainer, { workspacePath }));

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    await applyPendingComposerTextInsert(workspacePath);
    expect(await screen.findByRole("button", { name: "确认" })).not.toBeNull();

    const plainRecommendation = screen.getByRole("button", { name: plainLabel });
    fireEvent.pointerDown(plainRecommendation);
    fireEvent.click(plainRecommendation);

    await waitFor(() => expect(cancelPluginOperation).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toEqual({ requestId: 2, text: plainPrompt }),
    );
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("restores the same confirmation Popover after installation failure and retries with a new operation", async () => {
    const workspacePath = "/tmp/suggested-prompt-install-failed";
    let settleInstall!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "missing",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    installPlugin
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleInstall = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise(() => {
          // 第二次安装保持 pending，用于验证恢复后的确认按钮确实可重试。
        }),
      );
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    expect(await applyPendingComposerTextInsert(workspacePath)).toEqual({
      requestId: 1,
      text: pluginPrompt,
    });
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    expect(await screen.findByText("正在安装插件…")).not.toBeNull();
    const progressPopover = document.querySelector(
      '[data-draft-suggested-plugin-popover="progress"]',
    );

    act(() => {
      settleInstall({
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [{ code: "install_failed", message: "offline", severity: "error" }],
      });
    });
    const retryAction = await screen.findByRole("button", { name: "确认" });
    const retryPopover = document.querySelector(
      '[data-draft-suggested-plugin-popover="confirmation"]',
    );
    expect(retryPopover).toBe(progressPopover);
    expect(screen.queryByText("插件安装失败")).toBeNull();
    expect(document.querySelector('[data-draft-suggested-plugin-popover="error"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith("文档技能 安装失败：offline", {
      variant: "warning",
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[v4-suggested-prompts] 推荐插件安装失败，恢复确认态以便重试",
      expect.objectContaining({
        error: "offline",
        operationId: expect.any(String),
        pluginId: "document-skills@zcode-plugins-official",
        workspaceKey: workspacePath,
      }),
    );
    const firstOperationId = installPlugin.mock.calls[0]?.[0]?.operationId;
    fireEvent.click(retryAction);
    await waitFor(() => expect(installPlugin).toHaveBeenCalledTimes(2));
    expect(installPlugin.mock.calls[1]?.[0]?.operationId).not.toBe(firstOperationId);
    expect(await screen.findByText("正在安装插件…")).not.toBeNull();
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toBeNull();
  });

  it("fails a plugin installation at ten seconds, cancels it, and keeps the plain prompt", async () => {
    const workspacePath = "/tmp/suggested-prompt-install-timeout";
    let settleLateInstall!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "missing",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    installPlugin.mockReturnValue(
      new Promise((resolve) => {
        settleLateInstall = resolve;
      }),
    );
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );
    await screen.findByRole("button", { name: pluginLabel });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: pluginLabel }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const plainRequest = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath).composerTextInsertRequest;
      expect(plainRequest).toEqual({ requestId: 1, text: pluginPrompt });
      act(() => {
        useZCodeSessionStore
          .getState()
          .clearComposerTextInsertRequest(workspacePath, plainRequest!.requestId);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "确认" })).not.toBeNull());

      fireEvent.click(screen.getByRole("button", { name: "确认" }));
      expect(installPlugin).toHaveBeenCalledOnce();
      expect(screen.getByText("正在安装插件…")).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(9_999);
        await Promise.resolve();
      });
      expect(cancelPluginOperation).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "确认" })).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cancelPluginOperation).toHaveBeenCalledWith({ operationId: expect.any(String) });
      expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();
      expect(
        document.querySelector('[data-draft-suggested-plugin-popover="confirmation"]'),
      ).not.toBeNull();
      expect(document.querySelector('[data-draft-suggested-plugin-popover="error"]')).toBeNull();
      expect(toast).toHaveBeenCalledWith("文档技能 安装失败：安装超时", {
        variant: "warning",
      });
      expect(loggerWarn).toHaveBeenCalledWith(
        "[v4-suggested-prompts] 推荐插件安装失败，恢复确认态以便重试",
        expect.objectContaining({
          error: "安装超时",
          operationId: expect.any(String),
          pluginId: "document-skills@zcode-plugins-official",
          workspaceKey: workspacePath,
        }),
      );
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toBeNull();

      await act(async () => {
        settleLateInstall({
          dependencyClosure: ["document-skills@zcode-plugins-official"],
          installedPlugins: [
            {
              id: "document-skills@zcode-plugins-official",
              name: "document-skills",
              marketplace: "zcode-plugins-official",
              enabled: true,
              scope: "user",
            },
          ],
          diagnostics: [],
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce();
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
      ).toBeNull();
      expect(screen.queryByText("安装成功")).toBeNull();
      expect(screen.getByRole("button", { name: "确认" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the pure prompt and does not offer installation when refresh fails closed", async () => {
    const workspacePath = "/tmp/suggested-prompt-refresh-failed";
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "unavailable",
      diagnostics: [
        {
          code: "marketplace_refresh_failed",
          message: "offline",
          severity: "error",
        },
      ],
    });
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        isWebRemoteControl: true,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));

    await waitFor(() => expect(resolveSuggestedPluginReference).toHaveBeenCalledOnce());
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toEqual({ requestId: 1, text: pluginPrompt });
    expect(toast).not.toHaveBeenCalled();
    expect(resolveSuggestedPluginReference).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
      }),
    );
  });

  it("cancels the older operation, disables recommendations until cancellation settles, and drops late results", async () => {
    const workspacePath = "/tmp/suggested-prompt-cancel";
    let resolveOld!: (value: Record<string, unknown>) => void;
    let resolveCancel!: (value: Record<string, unknown>) => void;
    resolveSuggestedPluginReference.mockResolvedValue({
      stableId: "document-skills@zcode-plugins-official",
      status: "missing",
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official",
      diagnostics: [],
    });
    installPlugin.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    cancelPluginOperation.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    expect(await applyPendingComposerTextInsert(workspacePath)).toEqual({
      requestId: 1,
      text: pluginPrompt,
    });
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(installPlugin).toHaveBeenCalledOnce());
    expect(await screen.findByText("正在安装插件…")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: plainLabel,
      }),
    );

    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest
          ?.text,
      ).toBe(plainPrompt),
    );
    await waitFor(() => expect(cancelPluginOperation).toHaveBeenCalledOnce());
    expect(screen.queryByText("正在安装插件…")).toBeNull();
    expect((screen.getByRole("button", { name: pluginLabel }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: plainLabel }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      resolveCancel({ operationId: "old", cancelled: true });
      await Promise.resolve();
    });
    expect((screen.getByRole("button", { name: pluginLabel }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: plainLabel }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      resolveOld({
        dependencyClosure: ["document-skills@zcode-plugins-official"],
        installedPlugins: [
          {
            id: "document-skills@zcode-plugins-official",
            name: "document-skills",
            marketplace: "zcode-plugins-official",
            enabled: true,
            scope: "user",
          },
        ],
        diagnostics: [],
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: pluginLabel }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toEqual({
      requestId: 2,
      text: plainPrompt,
    });
    expect(getPluginReferenceCatalog).not.toHaveBeenCalled();
    expect(
      toast.mock.calls.some(
        ([message]) => String(message).includes("取消") || String(message).includes("中断"),
      ),
    ).toBe(false);
    expect(document.querySelector("[data-draft-suggested-plugin-popover]")).toBeNull();
  });

  it("invalidates an older Plugin prefill when a later click navigates to Automations", async () => {
    const workspacePath = "/tmp/suggested-prompt-navigation-latest-wins";
    const onOpenAutomations = vi.fn();
    let resolveCatalog!: (value: { authority: "workspace"; plugins: [] }) => void;
    getPluginReferenceCatalog.mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        workspacePath,
        onOpenAutomations,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: pluginLabel }));
    fireEvent.click(screen.getByRole("button", { name: automationsLabel }));

    expect(onOpenAutomations).toHaveBeenCalledOnce();
    await act(async () => {
      resolveCatalog({ authority: "workspace", plugins: [] });
      await Promise.resolve();
    });
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath).composerTextInsertRequest,
    ).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
