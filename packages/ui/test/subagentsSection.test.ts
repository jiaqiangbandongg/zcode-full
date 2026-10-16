// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createElement, type ChangeEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, TID_SUBAGENT_ROW, testId } from "@zcode/shared";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";

const capturedButtons: Array<Record<string, unknown>> = [];
const capturedModelConfigSelects: Array<Record<string, unknown>> = [];
const capturedThoughtLevelControls: Array<Record<string, unknown>> = [];
let useStateCallCount = 0;
let stateOverrides = new Map<number, unknown>();
let onManageModels = vi.fn();
let useRealReactHooks = false;
const mockTabs = vi.hoisted(() => ({ tabs: [] as unknown[] }));
const mockInitializePlugins = vi.hoisted(() => vi.fn(async () => {}));
const mockSubagentsService = vi.hoisted(() => ({
  list: vi.fn(async () => ({
    agents: [],
    userAgents: [],
    pluginAgents: [],
    capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
  })),
  getPrimaryUserAgentsDirectory: vi.fn(async () => ({ path: "/tmp/agents" })),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  setEnabled: vi.fn(),
  setBuiltInModelOverride: vi.fn(),
  setPluginAgentModelOverride: vi.fn(),
}));
const mockRefreshLoadedSubagentsStoreForWorkspace = vi.hoisted(() => vi.fn(async () => {}));
const mockUseModelProviders = vi.hoisted(() =>
  vi.fn(() => ({
    displayOrder: { providerIds: [] },
    loading: false,
    modelProviders: [],
  })),
);
const mockToolbarConfigState = vi.hoisted(() => ({
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: "custom-openai/gpt-5.4",
      options: [
        {
          value: "custom-openai/gpt-5.4",
          name: "gpt-5.4",
          modelProviderId: "custom-openai",
          modelProviderName: "Custom OpenAI",
          modelThoughtLevels: ["low", "high"],
          modelDefaultThoughtLevel: "high",
        },
        {
          value: "custom-openai/glm-5.2",
          name: "glm-5.2",
          modelProviderId: "custom-openai",
          modelProviderName: "Custom OpenAI",
          modelThoughtLevels: ["high", "max"],
          modelDefaultThoughtLevel: "max",
        },
        {
          value: "custom-openai/plain-chat",
          name: "plain-chat",
          modelProviderId: "custom-openai",
          modelProviderName: "Custom OpenAI",
          modelThoughtLevels: [],
        },
      ],
    },
  ],
  status: "ready" as "idle" | "loading" | "ready" | "error",
}));
const mockModelSelectionView = vi.hoisted(() => ({
  revision: 1,
  providers: [
    {
      providerId: "custom-openai",
      config: {
        label: "Custom OpenAI",
        access: { type: "api-key" as const, apiKey: "token" },
        api: {
          type: "openai-chat-completions" as const,
          baseUrl: "https://example.test/v1",
        },
        models: ["gpt-5.4", "glm-5.2", "plain-chat"],
      },
      models: [
        {
          modelId: "gpt-5.4",
          config: {
            optionSpecs: {
              reasoningLevel: {
                values: ["low", "high"],
                map: "{}",
              },
              maxOutputTokens: { max: 32_000, map: "{}" },
            },
          },
        },
        {
          modelId: "glm-5.2",
          config: {
            optionSpecs: {
              reasoningLevel: {
                values: ["high", "max"],
                map: "{}",
              },
              maxOutputTokens: { max: 32_000, map: "{}" },
            },
          },
        },
        {
          modelId: "plain-chat",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["disabled"], map: "{}" },
              maxOutputTokens: { max: 32_000, map: "{}" },
            },
          },
        },
      ],
    },
  ],
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) =>
      useRealReactHooks ? actual.useEffect(effect, dependencies) : undefined,
    useState: (initialValue: unknown) => {
      if (useRealReactHooks) {
        return actual.useState(initialValue);
      }
      useStateCallCount += 1;
      if (stateOverrides.has(useStateCallCount)) {
        return [stateOverrides.get(useStateCallCount), vi.fn()] as const;
      }
      if (useStateCallCount === 1) {
        return [[], vi.fn()] as const;
      }
      if (useStateCallCount === 2) {
        return [{ userScopeAvailable: false, userScopeReason: "desktop_only" }, vi.fn()] as const;
      }
      if (useStateCallCount === 3) {
        return [false, vi.fn()] as const;
      }
      if (useStateCallCount === 4) {
        return [false, vi.fn()] as const;
      }
      return [typeof initialValue === "function" ? initialValue() : initialValue, vi.fn()] as const;
    },
  };
});

vi.mock("lucide-react", () => ({
  ArrowLeft: (props: Record<string, unknown>) => createElement("svg", props),
  Bot: (props: Record<string, unknown>) => createElement("svg", props),
  Check: (props: Record<string, unknown>) => createElement("svg", props),
  ChevronDown: (props: Record<string, unknown>) => createElement("svg", props),
  CircleHelp: (props: Record<string, unknown>) =>
    createElement("svg", { ...props, "data-icon": "reasoning-unavailable" }),
  FolderOpen: (props: Record<string, unknown>) => createElement("svg", props),
  InfoIcon: (props: Record<string, unknown>) => createElement("svg", props, "info"),
  Download: (props: Record<string, unknown>) => createElement("svg", props),
  Import: (props: Record<string, unknown>) => createElement("svg", props),
  SquareArrowRightEnter: (props: Record<string, unknown>) => createElement("svg", props),
  Loader2: (props: Record<string, unknown>) => createElement("svg", props),
  MoreHorizontal: (props: Record<string, unknown>) => createElement("svg", props),
  Pencil: (props: Record<string, unknown>) => createElement("svg", props),
  Plus: (props: Record<string, unknown>) => createElement("svg", props),
  RefreshCw: (props: Record<string, unknown>) => createElement("svg", props),
  RefreshCcw: (props: Record<string, unknown>) => createElement("svg", props),
  Search: (props: Record<string, unknown>) => createElement("svg", props),
  Trash2: (props: Record<string, unknown>) => createElement("svg", props),
  X: (props: Record<string, unknown>) => createElement("svg", props),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) => {
    capturedButtons.push({ children, ...props });
    return createElement("button", props, children);
  },
}));

vi.mock("@/ModelConfigSelect.js", () => ({
  ModelConfigSelect: ({ triggerLabel, normalizedValue, ...props }: Record<string, unknown>) => {
    capturedModelConfigSelects.push({
      triggerLabel,
      normalizedValue,
      ...props,
    });
    return createElement(
      "button",
      {
        type: "button",
        "data-model-current-value": normalizedValue,
      },
      triggerLabel,
    );
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { tabs: unknown[] }) => unknown) => selector(mockTabs),
}));

vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ plugins: [], availablePlugins: [], initialize: mockInitializePlugins }),
}));

vi.mock("@/settings/PluginScopeMenu.js", () => ({
  PluginScopeMenu: () => createElement("button", null, "scope"),
  getPluginWorkspaceKey: () => "workspace",
  isPluginScopeWorkspaceConnected: () => true,
}));

vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", () => ({
  ThoughtLevelCycleControl: (props: Record<string, unknown>) => {
    capturedThoughtLevelControls.push(props);
    return createElement("button", {
      type: "button",
      "data-testid": "subagent-thought-level",
    });
  },
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectItem: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectTrigger: ({ children }: { children: unknown }) => createElement("button", null, children),
  SelectValue: () => createElement("span"),
}));

vi.mock("@/components/ui/tabs.js", () => ({
  Tabs: ({ children }: { children: unknown }) => createElement("div", null, children),
  TabsList: ({ children }: { children: unknown }) => createElement("div", null, children),
  TabsTrigger: ({ children, value }: { children: unknown; value: string }) =>
    createElement("button", { type: "button", "data-value": value }, children),
}));

vi.mock("@/components/ui/switch.js", () => ({
  Switch: ({ onCheckedChange, ...props }: Record<string, unknown>) =>
    createElement("input", {
      type: "checkbox",
      role: "switch",
      ...props,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        if (typeof onCheckedChange === "function") {
          (onCheckedChange as (checked: boolean) => void)(event.target.checked);
        }
      },
    }),
}));

vi.mock("@/components/ui/textarea.js", () => ({
  Textarea: (props: Record<string, unknown>) => createElement("textarea", props),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => vi.fn(async () => true),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    openInFileManager: vi.fn(async () => ({ success: true })),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => ({
    subagentsService: mockSubagentsService,
  }),
}));

vi.mock("@/store/subagentsStore.js", () => ({
  refreshLoadedSubagentsStoreForWorkspace: mockRefreshLoadedSubagentsStoreForWorkspace,
}));

vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: mockUseModelProviders,
}));

vi.mock("@/hooks/useModelSelectionView.js", () => {
  return {
    useModelSelectionView: () => ({
      state: { status: "ready", view: mockModelSelectionView },
      reload: vi.fn(),
    }),
    useModelSelectionServiceView: () => ({
      state: { status: "ready", view: mockModelSelectionView },
      reload: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({
    configOptions: mockToolbarConfigState.configOptions,
    loading: mockToolbarConfigState.status === "loading",
    error: mockToolbarConfigState.status === "error",
    status: mockToolbarConfigState.status,
  }),
}));

vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => ({
    snapshot: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
        const messages: Record<string, string> = {
          "settings.subagents.description": "Manage subagents.",
          "settings.subagents.workspaceScopeUnsupported":
            "Workspace-level creation or editing is unsupported",
          "settings.subagents.addNew": "New subagent",
          "settings.create.action": "New",
          "settings.resourceActions.import": "Import",
          "settings.resourceActions.export": "Export",
          "settings.resourceActions.more": "More actions",
          "common.loading": "Loading...",
          "common.refresh": "Refresh",
          "settings.subagents.openUserAgentsFolder": "Open user subagents folder",
          "settings.subagents.noDescription": "No description",
          "settings.skills.refresh": "Refresh",
          "settings.skills.refreshing": "Refreshing...",
          "settings.subagents.searchPlaceholder": "Search subagents",
          "settings.subagents.userScopeDesktopOnly": "Subagents are desktop only.",
          "settings.subagents.empty": "No subagents found",
          "settings.subagents.group.user": "Installed",
          "settings.subagents.group.plugin": "Plugin subagents",
          "settings.subagents.group.plugin.hint": "Plugin agents are read-only.",
          "settings.subagents.group.builtIn": "Built-in subagents",
          "settings.subagents.group.builtIn.hint": "Built-in agents are read-only.",
          "settings.modelProvider.connectionMode.apiKeyBadge": "API",
          "settings.modelProvider.connectionMode.codingPlanBadge": "Individual",
          "settings.modelProvider.connectionMode.startPlan": "Start Plan",
          "settings.modelProvider.connectionMode.startPlanBadge": "Start",
          "settings.modelProvider.connectionMode.teamPlan": "Team Plan",
          "settings.modelProvider.connectionMode.teamPlanBadge": "Team",
          "settings.subagents.scope.builtIn": "Built-in",
          "settings.subagents.scope.plugin": "Plugin",
          "settings.scope.user": "User",
          "settings.subagents.model.select": "Select model",
          "settings.subagents.model.inherit": "Inherit default",
          "settings.subagents.model.defaultMain": "Inherit default",
          "settings.subagents.model.main": "Main model",
          "settings.subagents.reasoningUnavailable": "Reasoning effort unavailable",
          "settings.subagents.toolsCount": `${values?.count ?? 0} tools`,
          "settings.subagents.tools.all": "All tools",
          "settings.subagents.tools.inherit": "Inherit tools",
          "settings.subagents.toggleAria": `Toggle ${values?.name ?? ""}`,
          "settings.subagents.form.injectAgentsMd.label": "Inject AGENTS.md",
          "settings.modelProvider.apiKey": "API key",
          "settings.modelProvider.connectionMode.codingPlan": "Individual Plan",
          "chat.toolbar.model.manageModels": "Manage models",
          "settings.subagents.form.validation.thoughtLevelUnavailable": "Select a supported effort",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/settings/SettingsResourceGroupHeader.js", () => ({
  SettingsResourceGroupHeader: ({ title }: { title: string }) => createElement("h3", null, title),
}));

async function renderSubagentsSection() {
  useStateCallCount = 0;
  const { SubagentsSection } = await import("../src/settings/SubagentsSection.js");
  return renderToStaticMarkup(
    createElement(SubagentsSection, {
      onManageModels,
      workspacePath: "/repo",
    }),
  );
}

async function renderInteractiveSubagentsSection() {
  useRealReactHooks = true;
  const { SubagentsSection } = await import("../src/settings/SubagentsSection.js");
  return render(
    createElement(SubagentsSection, {
      onManageModels,
      workspacePath: "/repo",
    }),
  );
}

function findButton(label: string) {
  return capturedButtons.find((button) => button["aria-label"] === label);
}

describe("SubagentsSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    capturedButtons.length = 0;
    capturedModelConfigSelects.length = 0;
    capturedThoughtLevelControls.length = 0;
    useStateCallCount = 0;
    stateOverrides = new Map<number, unknown>();
    onManageModels = vi.fn();
    useRealReactHooks = false;
    mockTabs.tabs = [];
    mockInitializePlugins.mockReset().mockResolvedValue(undefined);
    mockToolbarConfigState.status = "ready";
    vi.clearAllMocks();
    mockSubagentsService.list.mockResolvedValue({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: {
        userScopeAvailable: false,
        userScopeReason: "desktop_only",
      },
    });
    mockRefreshLoadedSubagentsStoreForWorkspace.mockResolvedValue(undefined);
  });

  it.each([false, true])(
    "插件初始化晚于首读时刷新用户页资源；卸载=%s 不消费迟到结果",
    async (unmounted) => {
      mockTabs.tabs = [{ kind: "workspace", id: "local", workspacePath: "/repo" }];
      let resolveInventory!: () => void;
      mockInitializePlugins.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveInventory = resolve;
          }),
      );
      await renderInteractiveSubagentsSection();
      await waitFor(() => expect(mockSubagentsService.list).toHaveBeenCalledTimes(1));
      expect(mockInitializePlugins).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/repo", configScope: "user" }),
      );
      if (unmounted) cleanup();
      await act(async () => {
        resolveInventory();
        await Promise.resolve();
      });
      expect(mockSubagentsService.list).toHaveBeenCalledTimes(unmounted ? 1 : 2);
      expect(mockSubagentsService.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspacePath: "", mode: "settingsUserOnly" }),
      );
    },
  );

  it("keeps same-name plugin subagents in separate marketplace groups", async () => {
    const { groupPluginAgentsById } = await import("../src/settings/SubagentsSection.js");
    const groups = groupPluginAgentsById([
      {
        id: "official-agent",
        name: "official-agent",
        description: "",
        systemPrompt: "",
        path: "/official",
        scope: "workspace",
        source: "plugin",
        enabled: true,
        pluginId: "computer-use@zcode-plugins-official",
        pluginName: "computer-use",
      },
      {
        id: "custom-agent",
        name: "custom-agent",
        description: "",
        systemPrompt: "",
        path: "/custom",
        scope: "workspace",
        source: "plugin",
        enabled: true,
        pluginId: "zcode-cua@custom-marketplace",
        pluginName: "zcode-cua",
      },
    ]);

    expect(groups.map(([key, items]) => [key, items[0]?.id])).toEqual([
      ["computer-use@zcode-plugins-official", "official-agent"],
      ["zcode-cua@custom-marketplace", "custom-agent"],
    ]);
  });

  it("hides user-level write actions when user subagents are unavailable", async () => {
    const html = await renderSubagentsSection();

    expect(findButton("New")).toBeUndefined();
    expect(findButton("Open user subagents folder")).toBeUndefined();
    expect(html).not.toContain("Workspace-level creation or editing is unsupported");
    expect(html).toContain("Subagents are desktop only.");
  });

  it("renders plugin subagents in their own read-only group", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "plugin:feature-dev@claude-plugins-official:code-architect",
            name: "feature-dev:code-architect",
            description: "Designs feature architectures",
            systemPrompt: "Architect.",
            path: "/cache/feature-dev/agents/code-architect.md",
            scope: "user",
            source: "plugin",
            enabled: true,
            readOnly: true,
          },
        ],
      ],
    ]);

    const html = await renderSubagentsSection();

    expect(html).toContain("Feature Dev");
    expect(html).toContain("feature-dev:code-architect");
  });

  it("gates the enabled toggle on user scope instead of general editability", async () => {
    // Bugfix 回归：workspace profile 可编辑之后仍不能展示启用开关——runtime 只对 user scope
    // 应用 disabledAgentIds（CLI isDisabledUserProfile 对 source !== "user" 直接 false，
    // workspace profile 的 source 是 "project"），开关点了会静默回弹。
    const source = readFileSync("packages/ui/src/settings/SubagentsSection.tsx", "utf8");
    expect(source).toMatch(/function supportsEnabledToggle\([\s\S]*?agent\.scope === "user"/);
    expect(source).toMatch(/\{showEnabledToggle \? \(\s*<Switch/);
    expect(source).toContain("const showEnabledToggle = supportsEnabledToggle(agent);");
    expect(source).toContain("if (!supportsEnabledToggle(agent)) {");
  });

  it("projects one settings row per plugin agent file while keeping runtime aliases separate", async () => {
    const { projectSettingsSubagents } = await import("../src/settings/SubagentsSection.js");
    const canonical = {
      id: "plugin:feature-dev@claude-plugins-official:code-architect",
      name: "feature-dev:code-architect",
      description: "Designs feature architectures",
      systemPrompt: "Architect.",
      path: "/cache/feature-dev/agents/code-architect.md",
      scope: "user" as const,
      source: "plugin" as const,
      enabled: true,
      readOnly: true,
    };
    const alias = {
      ...canonical,
      id: "plugin:feature-dev@claude-plugins-official:code-architect:alias",
      name: "code-architect",
    };
    const builtIn = {
      id: "built-in:explore",
      name: "Explore",
      description: "Search broadly",
      systemPrompt: "Search.",
      path: "built-in:Explore",
      scope: "built-in" as const,
      source: "built-in" as const,
      enabled: true,
      readOnly: true,
    };

    expect(
      projectSettingsSubagents({
        agents: [builtIn, alias, canonical],
        userAgents: [],
        pluginAgents: [canonical],
        capability: { userScopeAvailable: true },
      }).map((agent) => agent.name),
    ).toEqual(["Explore", "feature-dev:code-architect"]);
  });

  it("renders wildcard tools as all tools instead of a single tool", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "Search.",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            tools: ["*"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    const html = await renderSubagentsSection();

    expect(html).toContain("Explore");
    expect(html).toContain("All tools");
    expect(html).not.toContain("1 tools");
  });

  it("renders model controls for built-in subagents while keeping user model badges", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "Search.",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            tools: ["Read"],
          },
          {
            id: "user:code-reviewer",
            name: "code-reviewer",
            description: "Review code",
            systemPrompt: "Review.",
            color: "blue",
            modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
            tools: ["Read", "Grep"],
            path: "/tmp/agents/code-reviewer.md",
            scope: "user",
            source: "user",
            enabled: true,
            readOnly: false,
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    const html = await renderSubagentsSection();

    expect(html).toContain("Explore");
    expect(html).toContain("code-reviewer");
    expect(html).toContain("Inherit default");
    expect(html).toContain("gpt-5.4");
    const container = document.createElement("div");
    container.innerHTML = html;
    const builtInRow = container.querySelector(
      `[data-testid="${testId(TID_SUBAGENT_ROW, "Explore")}"]`,
    );
    const userRow = container.querySelector(
      `[data-testid="${testId(TID_SUBAGENT_ROW, "code-reviewer")}"]`,
    );
    expect(builtInRow?.classList.contains("grid-cols-[auto_minmax(0,1fr)]")).toBe(true);
    expect(builtInRow?.classList.contains("sm:grid-cols-[auto_minmax(0,1fr)_auto]")).toBe(true);
    expect(builtInRow?.lastElementChild?.classList.contains("col-span-2")).toBe(true);
    expect(builtInRow?.lastElementChild?.classList.contains("sm:col-span-1")).toBe(true);
    expect(userRow?.classList.contains("grid-cols-[auto_minmax(0,1fr)_auto]")).toBe(true);
    expect(userRow?.classList.contains("sm:grid-cols-[auto_minmax(0,1fr)_auto]")).toBe(false);
    expect(userRow?.lastElementChild?.classList.contains("shrink-0")).toBe(true);
    expect(userRow?.lastElementChild?.classList.contains("col-span-2")).toBe(false);
    expect(capturedModelConfigSelects).toEqual([
      expect.objectContaining({
        normalizedValue: "inherit",
        showManageModelsAction: false,
        triggerLabel: "Inherit default",
        contentSide: "top",
        contentAlign: "end",
      }),
    ]);
  });

  it("offers disabled without implicitly selecting it when reasoning is missing", async () => {
    const plainModel = "custom:custom-openai:plain-chat";
    const customAgent = {
      id: "user:plain-reviewer",
      name: "plain-reviewer",
      description: "Review without reasoning",
      systemPrompt: "Review.",
      path: "/tmp/agents/plain-reviewer.md",
      scope: "user",
      source: "user",
      enabled: true,
      readOnly: false,
      modelSelection: { providerId: "custom-openai", modelId: "plain-chat" },
      tools: ["Read"],
    };
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "Search.",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "custom-openai", modelId: "plain-chat" },
            modelSelectionOverride: { providerId: "custom-openai", modelId: "plain-chat" },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    await renderSubagentsSection();

    expect(capturedModelConfigSelects).toEqual([
      expect.objectContaining({ normalizedValue: plainModel }),
    ]);
    expect(capturedThoughtLevelControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({
          currentValue: "",
          options: [{ value: "disabled", name: "disabled" }],
        }),
      }),
    ]);

    capturedModelConfigSelects.length = 0;
    capturedThoughtLevelControls.length = 0;
    stateOverrides = new Map<number, unknown>([
      [1, []],
      [2, { userScopeAvailable: true }],
      [7, true],
      [8, customAgent],
    ]);

    await renderSubagentsSection();

    expect(capturedModelConfigSelects).toEqual([
      expect.objectContaining({ normalizedValue: plainModel }),
    ]);
    expect(capturedThoughtLevelControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({ currentValue: "" }),
      }),
    ]);
  });

  it("shows built-in overrides and persists model changes through the subagents service", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:general-purpose",
            name: "general-purpose",
            description: "General-purpose agent",
            systemPrompt: "",
            path: "built-in:general-purpose",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            tools: ["*"],
          },
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: {
              providerId: "custom-openai",
              modelId: "glm-5.2",
              options: { reasoningLevel: "high" },
            },
            modelSelectionOverride: {
              providerId: "custom-openai",
              modelId: "glm-5.2",
              options: { reasoningLevel: "high" },
            },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    const html = await renderSubagentsSection();
    const generalPurposePicker = capturedModelConfigSelects.find(
      (picker) => picker.triggerLabel === "Inherit default",
    );
    const explorePicker = capturedModelConfigSelects.find(
      (picker) => picker.normalizedValue === "custom:custom-openai:glm-5.2",
    );

    expect(html).toContain("Inherit default");
    expect(explorePicker).toMatchObject({
      normalizedValue: "custom:custom-openai:glm-5.2",
      triggerLabel: "glm-5.2",
      showManageModelsAction: false,
    });
    expect(explorePicker?.tooltipTitle).toBeUndefined();
    expect(explorePicker?.footerActions).toContainEqual(
      expect.objectContaining({
        key: "subagent-model:built-in-default",
        label: "Inherit default",
        selected: false,
      }),
    );
    expect(generalPurposePicker?.onValueChange).toBeTypeOf("function");
    await (generalPurposePicker!.onValueChange as (value: string) => Promise<void>)(
      "custom:custom-openai:gpt-5.4",
    );

    expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
      agentName: "general-purpose",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
    });
    await waitFor(() =>
      expect(mockSubagentsService.list).toHaveBeenCalledWith({
        workspacePath: "",
        workspaceIdentity: undefined,
        provider: "glm",
        mode: "settingsUserOnly",
      }),
    );
  });

  it("persists changed and explicitly selected built-in reasoning efforts", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
            modelSelectionOverride: { providerId: "custom-openai", modelId: "gpt-5.4" },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    await renderSubagentsSection();
    const effortControl = capturedThoughtLevelControls[0];
    if (!effortControl) {
      throw new Error("Expected the built-in reasoning effort control to render");
    }

    expect(effortControl.option).toMatchObject({
      // 原选择未保存档位时保持空；下面显式选择 high/low 才写入。
      currentValue: "",
      options: [{ value: "low" }, { value: "high" }],
    });
    expect(effortControl.onCurrentValueCommit).toBeTypeOf("function");
    (effortControl.onCurrentValueCommit as (value: string) => void)("high");

    await waitFor(() => {
      expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
        agentName: "Explore",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      });
    });
    mockSubagentsService.setBuiltInModelOverride.mockClear();
    (effortControl.onValueChange as (value: string) => void)("low");

    await waitFor(() => {
      expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
        agentName: "Explore",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "low" },
        },
      });
    });
  });

  it("renders the shared model override control for plugin subagents and persists by agent id", async () => {
    // 插件文件只读；保存用户覆盖时沿用完整 Selection 和主动选模最高档，而非上游的旧双字段。
    const selection = {
      providerId: "custom-openai",
      modelId: "glm-5.2",
      options: { reasoningLevel: "high" },
    };
    const pluginAgent = {
      id: "plugin:document-skills@zcode-plugins-official:judge",
      name: "document-skills:judge",
      description: "Visual acceptance reviewer",
      systemPrompt: "Judge.",
      path: "/cache/document-skills/0.1.4/agents/judge.md",
      scope: "user",
      source: "plugin",
      pluginId: "document-skills@zcode-plugins-official",
      pluginName: "document-skills",
      enabled: true,
      readOnly: true,
      tools: ["Read", "Bash"],
      defaultModelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      modelSelection: selection,
      modelSelectionOverride: selection,
    };
    stateOverrides = new Map<number, unknown>([
      [1, [pluginAgent]],
      [2, { userScopeAvailable: true }],
    ]);
    const container = document.createElement("div");
    container.innerHTML = await renderSubagentsSection();
    const row = container.querySelector(
      `[data-testid="${testId(TID_SUBAGENT_ROW, pluginAgent.name)}"]`,
    );
    expect(row?.getAttribute("role")).toBeNull();
    expect(row?.classList.contains("sm:grid-cols-[auto_minmax(0,1fr)_auto]")).toBe(true);
    expect(
      container.querySelector(
        `[data-testid="${testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, pluginAgent.name)}"]`,
      ),
    ).not.toBeNull();
    const picker = capturedModelConfigSelects.find(
      (candidate) => candidate.normalizedValue === "custom:custom-openai:glm-5.2",
    );
    expect(picker).toMatchObject({ triggerLabel: "glm-5.2", showManageModelsAction: false });
    (picker!.onValueChange as (value: string) => void)("custom:custom-openai:gpt-5.4");
    await waitFor(() =>
      expect(mockSubagentsService.setPluginAgentModelOverride).toHaveBeenCalledWith({
        agentId: pluginAgent.id,
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      }),
    );
    expect(mockSubagentsService.setBuiltInModelOverride).not.toHaveBeenCalled();
    expect(mockSubagentsService.list).toHaveBeenCalled();
  });

  it("uses the new model's highest effort when the built-in model changes", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: {
              providerId: "custom-openai",
              modelId: "glm-5.2",
              options: { reasoningLevel: "low" },
            },
            modelSelectionOverride: {
              providerId: "custom-openai",
              modelId: "glm-5.2",
              options: { reasoningLevel: "low" },
            },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    await renderSubagentsSection();
    const picker = capturedModelConfigSelects.find(
      (candidate) => candidate.normalizedValue === "custom:custom-openai:glm-5.2",
    );
    const onValueChange = picker?.onValueChange as (value: string) => void;
    onValueChange("custom:custom-openai:glm-5.2");
    expect(mockSubagentsService.setBuiltInModelOverride).not.toHaveBeenCalled();

    onValueChange("custom:custom-openai:gpt-5.4");
    await waitFor(() => {
      expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
        agentName: "Explore",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      });
    });
  });

  it("restores the previous built-in model config when persistence fails", async () => {
    const agent = {
      id: "built-in:explore",
      name: "Explore",
      description: "Search broadly",
      systemPrompt: "",
      path: "built-in:Explore",
      scope: "built-in" as const,
      source: "built-in" as const,
      enabled: true,
      readOnly: true,
      modelSelection: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      modelSelectionOverride: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      tools: ["Read"],
    };
    mockSubagentsService.list.mockResolvedValue({
      agents: [agent],
      userAgents: [agent],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
    });
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    mockSubagentsService.setBuiltInModelOverride.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );

    await renderInteractiveSubagentsSection();
    await waitFor(() => {
      expect(
        capturedModelConfigSelects.some(
          (candidate) => candidate.normalizedValue === "custom:custom-openai:glm-5.2",
        ),
      ).toBe(true);
    });

    const initialPicker = capturedModelConfigSelects.findLast(
      (candidate) => candidate.normalizedValue === "custom:custom-openai:glm-5.2",
    );
    const onModelValueChange = initialPicker?.onValueChange;
    expect(onModelValueChange).toBeTypeOf("function");
    const beforeOptimisticRender = capturedModelConfigSelects.length;
    act(() => {
      (onModelValueChange as (value: string) => void)("custom:custom-openai:gpt-5.4");
    });
    await waitFor(() => {
      expect(
        capturedModelConfigSelects
          .slice(beforeOptimisticRender)
          .some((candidate) => candidate.normalizedValue === "custom:custom-openai:gpt-5.4"),
      ).toBe(true);
    });

    expect(rejectWrite).toBeTypeOf("function");
    const beforeRollbackRender = capturedModelConfigSelects.length;
    const beforeThoughtRollbackRender = capturedThoughtLevelControls.length;
    await act(async () => {
      rejectWrite!(new Error("write failed"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        capturedModelConfigSelects
          .slice(beforeRollbackRender)
          .some((candidate) => candidate.normalizedValue === "custom:custom-openai:glm-5.2"),
      ).toBe(true);
      expect(
        capturedThoughtLevelControls
          .slice(beforeThoughtRollbackRender)
          .some((candidate) => candidate.option?.currentValue === "high"),
      ).toBe(true);
    });
  });

  it("keeps the committed built-in config when the follow-up refresh fails", async () => {
    const agent = {
      id: "built-in:explore",
      name: "Explore",
      description: "Search broadly",
      systemPrompt: "",
      path: "built-in:Explore",
      scope: "built-in" as const,
      source: "built-in" as const,
      enabled: true,
      readOnly: true,
      modelSelection: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      modelSelectionOverride: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      tools: ["Read"],
    };
    mockSubagentsService.list.mockResolvedValue({
      agents: [agent],
      userAgents: [agent],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
    });
    mockRefreshLoadedSubagentsStoreForWorkspace.mockRejectedValueOnce(new Error("refresh failed"));
    let resolveWrite: (() => void) | undefined;
    mockSubagentsService.setBuiltInModelOverride.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    await renderInteractiveSubagentsSection();
    await waitFor(() => {
      expect(capturedThoughtLevelControls.at(-1)?.option).toMatchObject({
        currentValue: "high",
      });
    });

    const onThoughtLevelChange = capturedThoughtLevelControls.at(-1)?.onValueChange;
    expect(onThoughtLevelChange).toBeTypeOf("function");
    act(() => {
      (onThoughtLevelChange as (value: string) => void)("max");
    });

    await waitFor(() => {
      expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
        agentName: "Explore",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "glm-5.2",
          options: { reasoningLevel: "max" },
        },
      });
      expect(capturedThoughtLevelControls.at(-1)).toMatchObject({
        disabled: true,
        option: expect.objectContaining({ currentValue: "max" }),
      });
    });

    expect(resolveWrite).toBeTypeOf("function");
    // 显式控制持久化提交点，避免慢速 CI 中乐观渲染与后续刷新微任务乱序。
    await act(async () => {
      resolveWrite!();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRefreshLoadedSubagentsStoreForWorkspace).toHaveBeenCalledTimes(1);
      expect(capturedThoughtLevelControls.at(-1)).toMatchObject({
        disabled: false,
        option: expect.objectContaining({ currentValue: "max" }),
      });
    });
  });

  it("clears built-in model overrides through the default model item", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "custom-openai", modelId: "glm-5.2" },
            modelSelectionOverride: { providerId: "custom-openai", modelId: "glm-5.2" },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    await renderSubagentsSection();
    const explorePicker = capturedModelConfigSelects.find(
      (picker) => picker.normalizedValue === "custom:custom-openai:glm-5.2",
    );

    const defaultAction = (
      explorePicker?.footerActions as
        | Array<{ key: string; onSelect?: () => Promise<void> | void }>
        | undefined
    )?.find((action) => action.key === "subagent-model:built-in-default");
    expect(defaultAction?.onSelect).toBeTypeOf("function");
    await defaultAction!.onSelect!();

    expect(mockSubagentsService.setBuiltInModelOverride).toHaveBeenCalledWith({
      agentName: "Explore",
      modelSelection: undefined,
    });
  });

  it("keeps the saved label when a built-in model override is no longer available", async () => {
    const staleModel = "custom:retired-provider:GLM-5-Turbo";
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:general-purpose",
            name: "general-purpose",
            description: "General-purpose agent",
            systemPrompt: "",
            path: "built-in:general-purpose",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "retired-provider", modelId: "GLM-5-Turbo" },
            modelSelectionOverride: {
              providerId: "retired-provider",
              modelId: "GLM-5-Turbo",
            },
            tools: ["*"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    await renderSubagentsSection();

    expect(capturedModelConfigSelects).toContainEqual(
      expect.objectContaining({
        normalizedValue: staleModel,
        triggerLabel: "Select model",
        showManageModelsAction: false,
      }),
    );
    expect(capturedModelConfigSelects).not.toContainEqual(
      expect.objectContaining({
        triggerLabel: "GLM-5-Turbo",
      }),
    );
    const stalePicker = capturedModelConfigSelects.find(
      (picker) => picker.normalizedValue === staleModel,
    );
    const selectableValues = ((stalePicker?.modelGroups ?? []) as ModelSelectGroup[]).flatMap(
      (group) => group.items.map((item) => item.value),
    );
    expect(selectableValues).not.toContain(staleModel);
  });

  it("renders tools permissions using the workspace-access row pattern", async () => {
    stateOverrides = new Map<number, unknown>([
      [2, { userScopeAvailable: true }],
      [7, true],
    ]);

    const html = await renderSubagentsSection();

    expect(html).toContain("settings.subagents.form.tools.card.title");
    expect(html).toContain("settings.subagents.form.tools.mode.all");
    expect(html).toContain("settings.subagents.form.tools.mode.custom");
    expect(html).toContain("settings.scope.label");
    expect(html).toContain("scope");
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain("Bash(git diff *)");
  });

  it("uses the real chat toolbar model picker values with an inherit option in the form", async () => {
    stateOverrides = new Map<number, unknown>([
      [2, { userScopeAvailable: true }],
      [7, true],
    ]);

    const html = await renderSubagentsSection();
    const modelPicker = capturedModelConfigSelects.at(-1);
    const modelGroups = modelPicker?.modelGroups as
      | Array<{
          key: string;
          label?: string;
          items: Array<{ value: string; name: string }>;
        }>
      | undefined;
    const modelValues = modelGroups?.flatMap((group) => group.items.map((item) => item.value));

    expect(html).toContain("Inherit default");
    expect(modelPicker).toMatchObject({
      normalizedValue: "inherit",
      triggerLabel: "Inherit default",
      showManageModelsAction: true,
      manageModelsLabel: "Manage models",
      contentSide: "bottom",
      triggerClassName: expect.stringContaining("bg-clip-border"),
    });
    expect(modelValues).toEqual([
      "custom:custom-openai:gpt-5.4",
      "custom:custom-openai:glm-5.2",
      "custom:custom-openai:plain-chat",
    ]);
    expect(modelPicker?.footerActions).toContainEqual(
      expect.objectContaining({
        key: "subagent-model:inherit",
        label: "Inherit default",
        selected: true,
      }),
    );
    expect(modelValues).not.toContain("main");
    expect(modelValues).not.toContain("lite");
    expect(modelValues).not.toContain("inherit");
    expect(modelPicker?.onManageModels).toBe(onManageModels);
    expect(mockUseModelProviders).not.toHaveBeenCalled();
  });

  it("derives refreshed edit form state from the saved custom model value", async () => {
    const { createSubagentFormInitialState } = await import("../src/settings/SubagentsSection.js");
    const customModel = "custom:728858ba-605a-4be5-80f8-15cf4de51eae:mimo-v2.5-pro";

    const formState = createSubagentFormInitialState({
      name: "qa-reviewer",
      description: "Review product flows",
      systemPrompt: "Review carefully",
      color: "blue",
      modelSelection: {
        providerId: "728858ba-605a-4be5-80f8-15cf4de51eae",
        modelId: "mimo-v2.5-pro",
        options: { reasoningLevel: "high" },
      },
      tools: ["Read", "Grep"],
    });

    expect(formState.model).toBe(customModel);
    expect(formState.thoughtLevel).toBe("high");
    expect(formState.injectAgentsMd).toBe(true);
    expect(formState.inheritAllTools).toBe(false);
    expect(formState.selectedTools).toEqual(["Read", "Grep"]);
  });

  it("preserves unknown intent and leaves an unsupported resolved effort unselected", async () => {
    const {
      createSubagentFormInitialState,
      isSubagentThoughtLevelAvailable,
      resolveSubagentThoughtOptionState,
    } = await import("../src/settings/SubagentsSection.js");
    const model = "custom:custom-openai:gpt-5.4";
    const initial = createSubagentFormInitialState({
      name: "qa-reviewer",
      description: "Review product flows",
      systemPrompt: "Review carefully",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "medium" },
      },
    });

    expect(initial.thoughtLevel).toBe("medium");
    const unknownState = resolveSubagentThoughtOptionState({
      model,
      modelAvailable: true,
      modelSelectionView: null,
      modelSelectionLoading: true,
      thoughtLevel: initial.thoughtLevel,
    });
    expect(unknownState).toEqual({ kind: "unknown", status: "loading" });
    expect(isSubagentThoughtLevelAvailable(unknownState, initial.thoughtLevel)).toBe(true);

    const supportedState = resolveSubagentThoughtOptionState({
      model,
      modelAvailable: true,
      modelSelectionView: mockModelSelectionView,
      modelSelectionLoading: false,
      thoughtLevel: initial.thoughtLevel,
    });
    expect(supportedState.option?.currentValue).toBe("");
    expect(initial.thoughtLevel).toBe("medium");
    expect(isSubagentThoughtLevelAvailable(supportedState, initial.thoughtLevel)).toBe(false);
    expect(isSubagentThoughtLevelAvailable(supportedState, "high")).toBe(true);
  });

  it("uses only the Local Host selection view to resolve reasoning", async () => {
    const { resolveSubagentThoughtOptionState } =
      await import("../src/settings/SubagentsSection.js");
    const model = "custom:custom-openai:glm-5.2";
    const state = resolveSubagentThoughtOptionState({
      model,
      modelAvailable: true,
      modelSelectionView: mockModelSelectionView,
      modelSelectionLoading: false,
      thoughtLevel: undefined,
    });

    expect(state).toMatchObject({
      kind: "supported",
      option: {
        currentValue: "",
        options: [{ value: "high" }, { value: "max" }],
      },
    });
  });

  it.each(["idle", "loading", "error"] as const)(
    "ignores the retired workspace catalog when its status is %s",
    async (workspaceConfigStatus) => {
      stateOverrides = new Map<number, unknown>([
        [
          1,
          [
            {
              id: "built-in:explore",
              name: "Explore",
              description: "Search broadly",
              systemPrompt: "",
              path: "built-in:Explore",
              scope: "built-in",
              source: "built-in",
              enabled: true,
              readOnly: true,
              modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
              modelSelectionOverride: { providerId: "custom-openai", modelId: "gpt-5.4" },
              tools: ["Read"],
            },
          ],
        ],
        [2, { userScopeAvailable: true }],
      ]);
      mockToolbarConfigState.status = workspaceConfigStatus;

      await renderSubagentsSection();

      expect(capturedThoughtLevelControls).toHaveLength(1);
      expect(capturedThoughtLevelControls[0]?.option).toMatchObject({ currentValue: "" });
    },
  );

  it("uses only the Local Host view to resolve reasoning capability", async () => {
    const { isSubagentThoughtLevelAvailable, resolveSubagentThoughtOptionState } =
      await import("../src/settings/SubagentsSection.js");
    const base = {
      model: "custom:custom-openai:gpt-5.4",
      modelAvailable: true,
      modelSelectionLoading: false,
      thoughtLevel: undefined,
    };

    const loading = resolveSubagentThoughtOptionState({
      ...base,
      modelSelectionView: null,
      modelSelectionLoading: true,
    });
    expect(loading).toEqual({ kind: "unknown", status: "loading" });
    // Registry 尚未发布时保持未知，不能把已保存的档位误判为非法并清空。
    expect(isSubagentThoughtLevelAvailable(loading, "max")).toBe(true);

    const error = resolveSubagentThoughtOptionState({
      ...base,
      modelSelectionView: null,
    });
    expect(error).toEqual({ kind: "unsupported" });

    const targetModelMissing = resolveSubagentThoughtOptionState({
      ...base,
      model: "custom:custom-openai:other-model",
      thoughtLevel: "max",
      modelSelectionView: mockModelSelectionView,
    });
    expect(targetModelMissing).toEqual({ kind: "unsupported" });
    expect(isSubagentThoughtLevelAvailable(targetModelMissing, "max")).toBe(false);

    const targetModelReconciling = resolveSubagentThoughtOptionState({
      ...base,
      thoughtLevel: "max",
      modelSelectionView: null,
      modelSelectionLoading: true,
    });
    expect(targetModelReconciling).toEqual({ kind: "unknown", status: "loading" });

    const authoritative = resolveSubagentThoughtOptionState({
      ...base,
      modelSelectionView: mockModelSelectionView,
    });
    expect(authoritative).toMatchObject({
      kind: "supported",
      option: {
        currentValue: "",
        options: [{ value: "low" }, { value: "high" }],
      },
    });
  });

  it("does not let retired workspace loading state override Local Host capability", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "custom-openai", modelId: "plain-chat" },
            modelSelectionOverride: { providerId: "custom-openai", modelId: "plain-chat" },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);
    mockToolbarConfigState.status = "loading";

    const html = await renderSubagentsSection();

    expect(capturedThoughtLevelControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({ currentValue: "" }),
      }),
    ]);
    expect(html).not.toContain('data-subagent-thought-level-loading="true"');
  });

  it("does not let retired workspace error state override Local Host capability", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "built-in:explore",
            name: "Explore",
            description: "Search broadly",
            systemPrompt: "",
            path: "built-in:Explore",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
            modelSelection: { providerId: "custom-openai", modelId: "plain-chat" },
            modelSelectionOverride: { providerId: "custom-openai", modelId: "plain-chat" },
            tools: ["Read"],
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);
    mockToolbarConfigState.status = "error";

    const html = await renderSubagentsSection();

    expect(capturedThoughtLevelControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({ currentValue: "" }),
      }),
    ]);
    expect(html).not.toContain('data-subagent-thought-level-unavailable="true"');
    expect(html).not.toContain('data-subagent-thought-level-loading="true"');
  });

  it("uses the Registry selection view while it refreshes when there is no workspace", async () => {
    const { resolveSubagentThoughtOptionState } =
      await import("../src/settings/SubagentsSection.js");
    const base = {
      model: "custom:custom-openai:gpt-5.4",
      modelAvailable: true,
      modelSelectionView: {
        revision: 1,
        providers: [
          {
            providerId: "custom-openai",
            config: {},
            models: [
              {
                modelId: "gpt-5.4",
                config: {
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["low", "high"],
                      map: "{}",
                    },
                    maxOutputTokens: { max: 32_000, map: "{}" },
                  },
                },
              },
            ],
          },
        ],
      },
      thoughtLevel: undefined,
    };

    expect(
      resolveSubagentThoughtOptionState({
        ...base,
        modelSelectionLoading: true,
      }),
    ).toMatchObject({
      kind: "supported",
      option: {
        currentValue: "",
        options: [{ value: "low" }, { value: "high" }],
      },
    });
    expect(
      resolveSubagentThoughtOptionState({
        ...base,
        modelSelectionLoading: false,
      }),
    ).toMatchObject({
      kind: "supported",
      option: {
        currentValue: "",
        options: [{ value: "low" }, { value: "high" }],
      },
    });
  });

  it("does not infer reasoning from the model name before the Registry view is available", async () => {
    const { resolveSubagentThoughtOptionState } =
      await import("../src/settings/SubagentsSection.js");

    expect(
      resolveSubagentThoughtOptionState({
        model: encodeCustomModelValue("provider-demo", "GLM-5.2"),
        modelAvailable: true,
        modelSelectionView: null,
        modelSelectionLoading: true,
        thoughtLevel: undefined,
      }),
    ).toEqual({ kind: "unknown", status: "loading" });
  });

  it("uses the Registry disabled option instead of App metadata", async () => {
    const { isSubagentThoughtLevelAvailable, resolveSubagentThoughtOptionState } =
      await import("../src/settings/SubagentsSection.js");
    const base = {
      model: "custom:custom-openai:plain-chat",
      modelAvailable: true,
      modelSelectionView: mockModelSelectionView,
      modelSelectionLoading: false,
      thoughtLevel: "high",
    };
    const disabled = resolveSubagentThoughtOptionState(base);

    expect(disabled).toMatchObject({
      kind: "supported",
      option: {
        currentValue: "",
        options: [{ value: "disabled" }],
      },
    });
    expect(isSubagentThoughtLevelAvailable(disabled, "high")).toBe(false);
  });

  it("defers persisted model availability validation only during initial provider loading", async () => {
    const { isSubagentModelAvailable } = await import("../src/settings/SubagentsSection.js");
    const model = "custom:custom-anthropic:claude-opus-4-8";

    expect(isSubagentModelAvailable([], model, true)).toBe(true);
    expect(isSubagentModelAvailable([], model, false)).toBe(false);
  });

  it("defaults new and legacy custom agents to AGENTS.md injection and preserves false", async () => {
    const { createSubagentFormInitialState } = await import("../src/settings/SubagentsSection.js");

    expect(createSubagentFormInitialState().injectAgentsMd).toBe(true);
    expect(
      createSubagentFormInitialState({
        name: "legacy-reviewer",
        description: "Legacy profile",
        systemPrompt: "Review carefully",
      }).injectAgentsMd,
    ).toBe(true);
    expect(
      createSubagentFormInitialState({
        name: "isolated-reviewer",
        description: "Do not inherit instructions",
        systemPrompt: "Review carefully",
        injectAgentsMd: false,
      }).injectAgentsMd,
    ).toBe(false);
  });

  it("saves AGENTS.md injection and an explicitly selected reasoning level", async () => {
    mockSubagentsService.list.mockResolvedValue({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
    });
    const view = await renderInteractiveSubagentsSection();

    const [addButton] = await screen.findAllByRole("button", { name: "New" });
    fireEvent.click(addButton);

    const onModelChange = capturedModelConfigSelects.at(-1)?.onValueChange;
    expect(onModelChange).toBeTypeOf("function");
    act(() => {
      (onModelChange as (value: string) => void)("custom:custom-openai:gpt-5.4");
    });
    await waitFor(() => {
      expect(capturedThoughtLevelControls.at(-1)).toMatchObject({
        // 主动选模使用最高档；后续显式选低档仍须按用户选择保存。
        option: expect.objectContaining({ currentValue: "high" }),
        onCurrentValueCommit: expect.any(Function),
      });
    });
    const onCurrentValueCommit = capturedThoughtLevelControls.at(-1)?.onCurrentValueCommit;
    expect(onCurrentValueCommit).toBeTypeOf("function");
    act(() => {
      (onCurrentValueCommit as (value: string) => void)("low");
    });

    const systemPromptInput = screen.getByPlaceholderText(
      "settings.subagents.form.systemPrompt.placeholder",
    );
    const injectSwitch = screen.getByRole("switch", {
      name: "Inject AGENTS.md",
    });
    expect(systemPromptInput.compareDocumentPosition(injectSwitch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(injectSwitch.parentElement?.classList.contains("items-center")).toBe(true);
    expect(screen.queryByText("Include parent user and workspace instructions.")).toBeNull();
    expect((injectSwitch as HTMLInputElement).checked).toBe(true);
    fireEvent.click(injectSwitch);
    expect((injectSwitch as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByPlaceholderText("settings.subagents.form.name.placeholder"), {
      target: { value: "isolated-reviewer" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("settings.subagents.form.description.placeholder"),
      { target: { value: "Review without parent instructions" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("settings.subagents.form.systemPrompt.placeholder"),
      { target: { value: "Review carefully." } },
    );
    fireEvent.submit(view.container.querySelector("form")!);

    await waitFor(() => {
      expect(mockSubagentsService.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            injectAgentsMd: false,
            modelSelection: {
              providerId: "custom-openai",
              modelId: "gpt-5.4",
              options: { reasoningLevel: "low" },
            },
          }),
        }),
      );
    });
  });

  it("preserves the unavailable selection but prompts to select a model in the edit form", async () => {
    const customModel = "custom:728858ba-605a-4be5-80f8-15cf4de51eae:mimo-v2.5-pro";
    const agent = {
      id: "user:qa-reviewer",
      name: "qa-reviewer",
      description: "Review product flows",
      systemPrompt: "Review carefully",
      color: "blue",
      modelSelection: {
        providerId: "728858ba-605a-4be5-80f8-15cf4de51eae",
        modelId: "mimo-v2.5-pro",
      },
      tools: ["Read", "Grep"],
      path: "/tmp/agents/qa-reviewer.md",
      scope: "user",
      source: "user",
      enabled: true,
      readOnly: false,
    };
    stateOverrides = new Map<number, unknown>([
      [1, [agent]],
      [2, { userScopeAvailable: true }],
      [8, agent],
    ]);
    mockToolbarConfigState.status = "error";

    const html = await renderSubagentsSection();

    expect(capturedModelConfigSelects.at(-1)).toMatchObject({
      normalizedValue: customModel,
      triggerLabel: "Select model",
    });
    expect(capturedThoughtLevelControls).toHaveLength(0);
    expect(html).not.toContain('data-subagent-thought-level-unavailable="true"');
  });

  it("treats unavailable persisted models as invalid form selections", async () => {
    const { isSubagentModelAvailable } = await import("../src/settings/SubagentsSection.js");
    const modelGroups = [
      {
        key: "custom-openai",
        label: "Custom OpenAI",
        items: [
          {
            key: "custom-openai:gpt-5.4",
            value: "custom:custom-openai:gpt-5.4",
            name: "gpt-5.4",
          },
        ],
      },
    ];

    expect(isSubagentModelAvailable(modelGroups, "custom:missing:mimo-v2.5-pro")).toBe(false);
    expect(isSubagentModelAvailable([], "custom:missing:mimo-v2.5-pro", true)).toBe(true);
    expect(isSubagentModelAvailable(modelGroups, "custom:custom-openai:gpt-5.4")).toBe(true);
    expect(isSubagentModelAvailable(modelGroups, "inherit")).toBe(true);
    expect(isSubagentModelAvailable(modelGroups, undefined)).toBe(true);
  });

  it("groups editable user agents and read-only built-ins like command settings lists", async () => {
    stateOverrides = new Map<number, unknown>([
      [
        1,
        [
          {
            id: "user:code-reviewer",
            name: "code-reviewer",
            description: "Review code",
            systemPrompt: "Review code carefully",
            color: "blue",
            tools: ["Read", "Grep"],
            path: "/tmp/agents/code-reviewer.md",
            scope: "user",
            source: "user",
            enabled: true,
            readOnly: false,
          },
          {
            id: "built-in:general-purpose",
            name: "general-purpose",
            description: "General-purpose agent",
            systemPrompt: "General agent",
            path: "builtin://general-purpose",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: true,
          },
        ],
      ],
      [2, { userScopeAvailable: true }],
    ]);

    const html = await renderSubagentsSection();

    expect(html).toContain("Installed");
    expect(html).toContain("Built-in subagents");
    expect(html).toContain("code-reviewer");
    expect(html).not.toContain("/tmp/agents/code-reviewer.md");
    expect(html).not.toContain("built-in:general-purpose");
    expect(html).toContain("general-purpose");
    expect(html).not.toContain("Workspace-level creation or editing is unsupported");
    expect(findButton("New")).toBeDefined();
    expect(findButton("Open user subagents folder")).toBeUndefined();
  });
});
