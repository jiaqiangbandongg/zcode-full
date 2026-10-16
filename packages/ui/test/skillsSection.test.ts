import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedButtons: Array<Record<string, unknown>> = [];
const capturedSwitches: Array<Record<string, unknown>> = [];
const openInFileManagerMock = vi.fn(async () => ({ success: true }));
const onCreateTaskMock = vi.fn();
const activateTabByPathMock = vi.fn();
const startDraftMock = vi.fn();
const setPendingComposerPrefillMock = vi.fn();
const invalidateDraftRuntimeMock = vi.fn();
const mockSkillsServiceList = vi.fn(async () => ({
  skills: [],
  capability: { userScopeAvailable: true },
  diagnostics: [],
}));
const mockSkillsServiceSetEnabled = vi.fn(async () => {});
let useStateCallCount = 0;
let mockSkillsState: unknown = [];
let mockCapabilityState: unknown = null;
let mockLoadedSkillTargetKeyState = "remote:ssh:dev:/tmp/workspace";
let mockSelectedSkillState: unknown = null;
let mockDiagnosticsState: unknown = [];
let mockDiagnosticsOpenState = false;
let activeWorkspacePath: string | null = "/tmp/workspace";
let activeWorkspaceIdentity: string | undefined = "remote:ssh:dev:/tmp/workspace";
let activeRemoteSessionId: string | undefined;
let activeRemoteTarget: unknown;
let activeScopeFilter: "user" | "workspace" = "workspace";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initialValue: unknown) => {
      useStateCallCount += 1;
      if (useStateCallCount === 1) {
        return [mockSkillsState, vi.fn()] as const;
      }
      if (useStateCallCount === 2) {
        return [mockCapabilityState ?? initialValue, vi.fn()] as const;
      }
      if (useStateCallCount === 3) {
        return [mockLoadedSkillTargetKeyState, vi.fn()] as const;
      }
      if (useStateCallCount === 6) {
        return [mockSelectedSkillState, vi.fn()] as const;
      }
      if (useStateCallCount === 7) {
        return [mockDiagnosticsState, vi.fn()] as const;
      }
      if (useStateCallCount === 8) {
        return [mockDiagnosticsOpenState, vi.fn()] as const;
      }
      return [initialValue, vi.fn()] as const;
    },
  };
});

vi.mock("lucide-react", () => ({
  AlertTriangle: (props: Record<string, unknown>) => createElement("svg", props),
  ChevronDown: (props: Record<string, unknown>) => createElement("svg", props),
  ChevronDownIcon: (props: Record<string, unknown>) => createElement("svg", props),
  ChevronRight: (props: Record<string, unknown>) => createElement("svg", props),
  ChevronUpIcon: (props: Record<string, unknown>) => createElement("svg", props),
  CheckIcon: (props: Record<string, unknown>) => createElement("svg", props),
  Download: (props: Record<string, unknown>) => createElement("svg", props),
  ExternalLink: (props: Record<string, unknown>) => createElement("svg", props),
  Folder: (props: Record<string, unknown>) => createElement("svg", props),
  Import: (props: Record<string, unknown>) => createElement("svg", props),
  SquareArrowRightEnter: (props: Record<string, unknown>) => createElement("svg", props),
  LayersPlus: (props: Record<string, unknown>) => createElement("svg", props),
  Loader2: (props: Record<string, unknown>) => createElement("svg", props),
  Loader2Icon: (props: Record<string, unknown>) => createElement("svg", props),
  MinusIcon: (props: Record<string, unknown>) => createElement("svg", props),
  MoreHorizontal: (props: Record<string, unknown>) => createElement("svg", props),
  Plus: (props: Record<string, unknown>) => createElement("svg", props),
  RefreshCcw: (props: Record<string, unknown>) => createElement("svg", props),
  Cable: (props: Record<string, unknown>) => createElement("svg", props),
  Search: (props: Record<string, unknown>) => createElement("svg", props),
  Settings2: (props: Record<string, unknown>) => createElement("svg", props),
  Trash2: (props: Record<string, unknown>) => createElement("svg", props),
  UploadCloud: (props: Record<string, unknown>) => createElement("svg", props),
  UserRound: (props: Record<string, unknown>) => createElement("svg", props),
  WandSparkles: (props: Record<string, unknown>) => createElement("svg", props),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) => {
    capturedButtons.push({ children, ...props });
    return createElement("button", props, children);
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/components/ui/progress.js", () => ({
  Progress: (props: Record<string, unknown>) => createElement("progress", props),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? createElement("div", { "data-dialog-open": true }, children) : null,
  DialogContent: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogFooter: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogHeader: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogTitle: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("h2", props, children),
}));

vi.mock("@/components/ui/switch.js", () => ({
  Switch: (props: Record<string, unknown>) => {
    capturedSwitches.push(props);
    return createElement("input", { type: "checkbox", ...props });
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
        const messages: Record<string, string> = {
          "settings.skills.description": "Manage workspace and user skills.",
          "common.refresh": "Refresh",
          "settings.resourceActions.import": "Import",
          "settings.resourceActions.export": "Export",
          "settings.resourceActions.more": "More actions",
          "settings.create.action": "New",
          "settings.skills.create.open": "New Skill",
          "settings.skills.import.open": "Import skills from external agents",
          "settings.skills.remoteContext": `Current remote workspace: ${values?.target ?? ""}`,
          "settings.skills.remoteSync.open": "Sync Skill",
          "settings.skills.import.title": "Import external agent skills",
          "settings.skills.import.description": "Scan reusable skills.",
          "settings.skills.import.scanning": "Scanning importable skills...",
          "settings.skills.import.empty": "No importable skills found.",
          "settings.skills.import.summary": `Found ${values?.count ?? 0} importable skills`,
          "settings.skills.import.selectAll": "Select all",
          "settings.skills.import.clearAll": "Clear all",
          "settings.skills.import.selectionCount": `${values?.selected ?? 0}/${values?.total ?? 0} selected`,
          "settings.skills.import.start": "Import selected skills",
          "settings.skills.import.targetLabel": "Import target",
          "settings.skills.import.target.global": "Import to Global",
          "settings.skills.import.target.project": "Import to Project",
          "settings.skills.import.modeLabel": "Import mode",
          "settings.skills.import.modeHelp": "Import mode help",
          "settings.skills.import.mode.copy": "Copy",
          "settings.skills.import.mode.symlink": "Symlink",
          "settings.skills.import.mode.copy.description": "Copy mode",
          "settings.skills.import.mode.symlink.description": "Symlink mode",
          "settings.skills.import.importing": "Importing skills into ZCode",
          "settings.skills.import.imported": "Imported",
          "settings.skills.import.skipped": "Skipped",
          "settings.skills.import.failed": "Failed",
          "settings.skills.import.completeDescription": "The skills list has been refreshed.",
          "settings.skills.import.finish": "Done",
          "settings.skills.refresh": "Refresh",
          "settings.skills.refreshing": "Refreshing...",
          "settings.skills.searchPlaceholder": "Search skills...",
          "settings.skills.filter.label": "Source Filter",
          "appHeader.openInFileManagerFailed": "Failed to open folder",
          "settings.skills.agent.claude": "Claude",
          "settings.skills.agent.agents": "Codex",
          "settings.skills.agent.opencode": "OpenCode",
          "settings.skills.agent.gemini": "Gemini",
          "settings.modelProvider.testModel.agentName.zcode_agent": "ZCode Agent",
          "settings.skills.empty": "No skills found",
          "settings.skills.noDescription": "No description",
          "settings.skills.detail.description": "Description",
          "settings.skills.detail.path": "File path",
          "settings.skills.detail.openPath": "Open",
          "settings.skills.detail.scope": "Scope",
          "settings.skills.detail.status": "Status",
          "settings.skills.detail.version": "Version",
          "settings.skills.detail.slug": "Slug",
          "settings.skills.detail.ownerId": "Owner ID",
          "settings.skills.detail.publishedAt": "Published at",
          "settings.skills.detail.enabled": "Enabled",
          "settings.skills.detail.disabled": "Disabled",
          "settings.skills.scope.personal": "Personal",
          "settings.skills.scope.plugin": "Plugin",
          "settings.skills.scope.workspaceFallback": "Project",
          "settings.skills.diagnostics.summary":
            `Skill diagnostics: ${values?.errorCount ?? 0} error(s), ` +
            `${values?.warningCount ?? 0} warning(s)`,
          "settings.skills.diagnostics.expand": "Expand diagnostics",
          "settings.skills.diagnostics.collapse": "Collapse diagnostics",
          "settings.skills.diagnostics.code.skill_missing_frontmatter": "Missing YAML frontmatter",
          "settings.skills.diagnostics.code.skill_invalid_name": "Invalid skill name",
          "settings.skills.diagnostics.code.skill_unknown_frontmatter": "Unknown frontmatter key",
          "settings.skills.copyToCommon": "Copy to Common",
          "settings.skills.removeFromCommon": "Remove from Common",
          "settingsSync.action.skip": "Not now",
          "settingsSync.action.rescan": "Scan again",
          "settingsSync.agent.zcode": "ZCode Agent",
          "settingsSync.agent.claudeCode": "Claude Code",
          "settingsSync.agent.codexCli": "Codex CLI",
          "settingsSync.agent.openCode": "OpenCode",
          "settingsSync.agent.agents": "Shared .agents",
          "settingsSync.category.skills": "Skills",
          "settingsSync.category.skills.description": "Copy local skills",
          "settingsSync.category.default.description": "Importable settings.",
          "onboarding.agentSettings.categoryToggleAllAria": "Toggle category",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const activeWorkspaceTab = {
      id: `workspace:${activeWorkspacePath ?? ""}`,
      kind: "workspace",
      label: "workspace",
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      remoteSessionId: activeRemoteSessionId,
      remoteTarget: activeRemoteTarget,
    };
    return selector({
      // Bugfix: useWorkspaceServices 会通过 tabs/activeTabId 识别远程 workspace，
      // 测试桩也要保持 TabStoreState 的最小真实形态，否则会在渲染阶段先于断言崩溃。
      activeTabId: activeWorkspaceTab.id,
      activeWorkspacePath: activeWorkspaceTab.workspacePath,
      activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity,
      tabs: [activeWorkspaceTab],
      activateTabByPath: activateTabByPathMock,
    });
  },
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        getWorkspaceState: () => ({
          selectedProvider: "claude",
          activeTaskId: null,
        }),
        startDraft: startDraftMock,
        setPendingComposerPrefill: setPendingComposerPrefillMock,
        invalidateDraftRuntime: invalidateDraftRuntimeMock,
      }),
    {
      getState: () => ({
        getWorkspaceState: () => ({
          selectedProvider: "claude",
          activeTaskId: null,
        }),
        startDraft: startDraftMock,
        setPendingComposerPrefill: setPendingComposerPrefillMock,
        invalidateDraftRuntime: invalidateDraftRuntimeMock,
      }),
    },
  ),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    openInFileManager: openInFileManagerMock,
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    skillsService: {
      list: mockSkillsServiceList,
      setEnabled: mockSkillsServiceSetEnabled,
    },
    skillSyncService: {
      listLocalUserSkillCandidates: vi.fn(async () => ({
        candidates: [],
        maxArchiveBytes: 0,
      })),
      listRemoteUserSkillStatuses: vi.fn(async () => ({ statuses: [] })),
      exportSkillsArchive: vi.fn(async () => ({
        archive: new Uint8Array(),
        archiveBytes: 0,
        skills: [],
      })),
      checkRemoteUserSkillWriteAccess: vi.fn(async () => ({
        ok: true,
        path: "/home/dev/.zcode/skills",
      })),
      importSkillsArchive: vi.fn(async () => ({ results: [] })),
    },
    mcpSyncService: {},
    settingsSyncService: {
      detect: vi.fn(async () => ({ agents: [] })),
      importSelected: vi.fn(async () => ({
        successCount: 0,
        skippedCount: 0,
        failedCount: 0,
        taskResults: [],
      })),
    },
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    services: {
      pluginManagementService: {},
      skillsService: {
        list: mockSkillsServiceList,
        setEnabled: mockSkillsServiceSetEnabled,
      },
      skillSyncService: {
        listLocalUserSkillCandidates: vi.fn(async () => ({
          candidates: [],
          maxArchiveBytes: 0,
        })),
        listRemoteUserSkillStatuses: vi.fn(async () => ({ statuses: [] })),
        exportSkillsArchive: vi.fn(async () => ({
          archive: new Uint8Array(),
          archiveBytes: 0,
          skills: [],
        })),
        checkRemoteUserSkillWriteAccess: vi.fn(async () => ({
          ok: true,
          path: "/home/dev/.zcode/skills",
        })),
        importSkillsArchive: vi.fn(async () => ({ results: [] })),
      },
    },
    remoteSessionId: activeRemoteSessionId ?? null,
    isRemoteTarget: Boolean(activeWorkspaceIdentity || activeRemoteSessionId || activeRemoteTarget),
    connectionKind: activeWorkspaceIdentity ? "remote-ready" : "local-ready",
    rpcReady: true,
  }),
  useWorkspaceServices: () => ({
    zcodeTaskService: {
      createTask: vi.fn(async () => ({
        taskId: "task-1",
        provider: "claude",
        initialSlashCommands: [],
      })),
    },
  }),
  useBaseWorkspaceServices: () => ({
    skillSyncService: {
      listLocalUserSkillCandidates: vi.fn(async () => ({
        candidates: [],
        maxArchiveBytes: 0,
      })),
      listRemoteUserSkillStatuses: vi.fn(async () => ({ statuses: [] })),
      exportSkillsArchive: vi.fn(async () => ({
        archive: new Uint8Array(),
        archiveBytes: 0,
        skills: [],
      })),
      checkRemoteUserSkillWriteAccess: vi.fn(async () => ({
        ok: true,
        path: "/home/dev/.zcode/skills",
      })),
      importSkillsArchive: vi.fn(async () => ({ results: [] })),
    },
    mcpSyncService: {},
  }),
}));

vi.mock("@/lib/providerCliIcon.js", () => ({
  renderProviderCliIcon: () => createElement("span", null, "icon"),
}));

async function renderSkillsSection() {
  useStateCallCount = 0;
  mockLoadedSkillTargetKeyState = activeWorkspaceIdentity?.trim() || activeWorkspacePath || "";
  const { SkillsSection } = await import("../src/settings/SkillsSection.js");
  return renderToStaticMarkup(
    createElement(SkillsSection, {
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      remoteSessionId: activeRemoteSessionId,
      remoteTarget: activeRemoteTarget,
      scopeFilter: activeScopeFilter,
      searchQuery: "",
      onCreateTask: onCreateTaskMock,
    }),
  );
}

function findButton(label: string) {
  return capturedButtons.find(
    (button) => button.children === label || button["aria-label"] === label,
  );
}

function findLinkButtonByLabel(label: string) {
  return capturedButtons.find(
    (button) =>
      button.variant === "link" && (button.children === label || button["aria-label"] === label),
  );
}

function findCreateSkillButton() {
  return capturedButtons.find(
    (button) => button["aria-label"] === "New" && typeof button.onClick === "function",
  );
}

describe("SkillsSection", () => {
  beforeEach(() => {
    capturedButtons.length = 0;
    capturedSwitches.length = 0;
    activateTabByPathMock.mockClear();
    onCreateTaskMock.mockClear();
    startDraftMock.mockClear();
    setPendingComposerPrefillMock.mockClear();
    invalidateDraftRuntimeMock.mockClear();
    openInFileManagerMock.mockClear();
    mockSkillsServiceList.mockClear();
    mockSkillsServiceList.mockResolvedValue({
      skills: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    mockSkillsServiceSetEnabled.mockClear();
    mockCapabilityState = null;
    mockSkillsState = [];
    mockLoadedSkillTargetKeyState = "remote:ssh:dev:/tmp/workspace";
    mockSelectedSkillState = null;
    mockDiagnosticsState = [];
    mockDiagnosticsOpenState = false;
    activeWorkspacePath = "/tmp/workspace";
    activeWorkspaceIdentity = "remote:ssh:dev:/tmp/workspace";
    activeRemoteSessionId = undefined;
    activeRemoteTarget = undefined;
    activeScopeFilter = "workspace";
    useStateCallCount = 0;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("顶部展示统一刷新按钮", async () => {
    await renderSkillsSection();

    expect(findButton("Refresh")).toBeTruthy();
  });

  it("顶部展示包含导入能力的更多操作菜单", async () => {
    mockCapabilityState = { userScopeAvailable: true };

    await renderSkillsSection();

    expect(findButton("More actions")).toBeTruthy();
  });

  it("connected SSH workspace shows remote skill sync entry", async () => {
    activeWorkspacePath = "/home/alice/project";
    activeWorkspaceIdentity = "ssh://alice@dev.example.com/home/alice/project";
    activeRemoteSessionId = "remote-session-1";
    activeRemoteTarget = {
      kind: "ssh",
      host: "dev.example.com",
      username: "alice",
      port: 22,
    };

    const html = await renderSkillsSection();

    expect(html).toContain("dev.example.com");
    expect(findButton("Sync Skill")).toBeTruthy();
  });

  it("connected WSL workspace shows remote skill sync entry", async () => {
    activeWorkspacePath = "/home/alice/project";
    activeWorkspaceIdentity = "remote:wsl:Ubuntu:/home/alice/project";
    activeRemoteSessionId = "remote-session-wsl";
    activeRemoteTarget = {
      kind: "wsl",
      distro: "Ubuntu",
      user: "alice",
    };

    const html = await renderSkillsSection();

    expect(html).toContain("WSL");
    expect(html).toContain("Ubuntu");
    expect(findButton("Sync Skill")).toBeTruthy();
  });

  it("技能详情弹窗会展示完整长描述和路径", async () => {
    const skill = {
      id: "skill-1",
      name: "feishu-drive",
      description:
        "飞书云空间文件管理 Skill。上传/下载/移动/搜索文件、创建文件夹、获取元数据等。当需要管理飞书云空间中的文件和文件夹时使用此 Skill。",
      body: "",
      path: "/Users/dev/.agents/skills/feishu-drive-1.0.0/SKILL.md",
      scope: "user",
      enabled: true,
      metadata: {
        slug: "feishu-drive",
        version: "1.0.0",
        ownerId: "owner-1",
        publishedAt: 1770965769673,
      },
    };
    mockCapabilityState = { userScopeAvailable: true };
    mockSkillsState = [skill];
    mockSelectedSkillState = skill;

    const html = await renderSkillsSection();

    expect(html).not.toContain(">Skill Details<");
    expect(html).not.toContain(">Source<");
    expect(html).toContain("feishu-drive");
    expect(html).toContain(
      "飞书云空间文件管理 Skill。上传/下载/移动/搜索文件、创建文件夹、获取元数据等。当需要管理飞书云空间中的文件和文件夹时使用此 Skill。",
    );
    expect(html).toContain(">Version<");
    expect(html).toContain(">1.0.0<");
    expect(html).toContain(">feishu-drive<");
    expect(html).toContain(">owner-1<");
    expect(html).toContain("2026-02-13T06:56:09.673Z");
    expect(html).toContain("/Users/dev/.agents/skills/feishu-drive-1.0.0/SKILL.md");
    expect(html).toContain(">Enabled<");
    expect(html).toContain('aria-label="Open"');
    expect(html).not.toContain("Copy to Common");
    expect(html).not.toContain("Remove from Common");
  });

  it("技能详情弹窗的文件路径可以打开", async () => {
    const skill = {
      id: "skill-1",
      name: "feishu-drive",
      description: "drive",
      body: "",
      path: "/Users/dev/.agents/skills/feishu-drive-1.0.0/SKILL.md",
      scope: "user",
      enabled: true,
    };
    mockCapabilityState = { userScopeAvailable: true };
    mockSkillsState = [skill];
    mockSelectedSkillState = skill;

    await renderSkillsSection();
    const openPathButton = findLinkButtonByLabel("Open");
    expect(openPathButton).toBeTruthy();
    (openPathButton?.onClick as () => void)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openInFileManagerMock).toHaveBeenCalledWith(
      "/Users/dev/.agents/skills/feishu-drive-1.0.0/SKILL.md",
    );
  });

  it("新建技能通过 Root 标准链路创建带结构化 skill-creator mention 的草稿", async () => {
    mockSkillsState = [
      {
        id: "glm:skill-creator@official",
        name: "skill-creator",
        description: "Create skills",
        body: "",
        path: "/tmp/workspace/.zcode/skills/skill-creator/SKILL.md",
        scope: "workspace",
        enabled: true,
      },
    ];

    await renderSkillsSection();
    const createButton = findCreateSkillButton();
    expect(createButton).toBeTruthy();
    (createButton?.onClick as (event: { defaultPrevented: boolean }) => void)?.({
      defaultPrevented: false,
    });

    const markdown = "[$skill-creator](/tmp/workspace/.zcode/skills/skill-creator/SKILL.md)";
    expect(onCreateTaskMock).toHaveBeenCalledTimes(1);
    expect(onCreateTaskMock).toHaveBeenCalledWith({
      provider: "glm",
      initialPrompt: `${markdown} `,
      initialPromptMention: {
        id: "skill:glm:skill-creator@official",
        category: "skills",
        label: "skill-creator",
        value: "skill-creator",
        markdown,
        description: "Create skills",
        data: {
          path: "/tmp/workspace/.zcode/skills/skill-creator/SKILL.md",
          scope: "workspace",
        },
      },
    });
    expect(startDraftMock).not.toHaveBeenCalled();
    expect(activateTabByPathMock).not.toHaveBeenCalled();
  });

  it("有诊断时顶部 banner 按严重级别统计，展开后列出具体条目", async () => {
    mockCapabilityState = { userScopeAvailable: true };
    mockDiagnosticsState = [
      {
        code: "skill_missing_frontmatter",
        severity: "error",
        message: "缺少 frontmatter",
        path: "/tmp/workspace/.zcode/skills/bad/SKILL.md",
      },
      {
        code: "skill_unknown_frontmatter",
        severity: "warning",
        message: "未识别字段: foo",
        path: "/tmp/workspace/.zcode/skills/other/SKILL.md",
        skillName: "other",
      },
    ];
    mockDiagnosticsOpenState = true;

    const html = await renderSkillsSection();

    expect(html).toContain("Skill diagnostics: 1 error(s), 1 warning(s)");
    expect(html).not.toContain("skill(s) failed to load");
    expect(html).toContain("Missing YAML frontmatter");
    expect(html).toContain("Unknown frontmatter key");
    expect(html).toContain("缺少 frontmatter");
    expect(html).toContain("/tmp/workspace/.zcode/skills/bad/SKILL.md");
  });

  it("Plugin 只展示当前 scope 且名称后不重复 scope 标签", async () => {
    mockCapabilityState = { userScopeAvailable: true };
    mockSkillsState = [
      {
        id: "skill-1",
        name: "repo-review",
        description: "review repo",
        body: "",
        path: "/tmp/workspace/.zcode/skills/repo-review/SKILL.md",
        scope: "workspace",
        enabled: true,
      },
      {
        id: "skill-2",
        name: "global-skill",
        description: "user skill",
        body: "",
        path: "/Users/dev/.zcode/skills/global-skill/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ];

    const html = await renderSkillsSection();

    expect(html).toContain("repo-review");
    expect(html).not.toContain("global-skill");
    expect(html).not.toContain("data-skill-scope");
  });

  it("设置页切换技能开关后会刷新同一远程工作区的聊天补全技能缓存", async () => {
    const skill = {
      id: "skill-1",
      name: "lark-approval",
      description: "approval",
      body: "",
      path: "/root/.zcode/skills/lark-approval/SKILL.md",
      scope: "user" as const,
      enabled: true,
    };
    mockCapabilityState = { userScopeAvailable: true };
    mockSkillsState = [skill];
    activeScopeFilter = "user";
    mockSkillsServiceList.mockResolvedValue({
      skills: [{ ...skill, enabled: false }],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    const { useSkillStore } = await import("../src/store/skillStore.js");
    useSkillStore.setState({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "remote:ssh:dev:/tmp/workspace",
      loadedWorkspacePath: "/tmp/workspace",
      loadedWorkspaceIdentity: "remote:ssh:dev:/tmp/workspace",
      provider: "glm",
      loadedProvider: "glm",
      skills: [skill],
      capability: { userScopeAvailable: true },
      loading: false,
      error: null,
    });

    await renderSkillsSection();
    (capturedSwitches[0]?.onCheckedChange as (checked: boolean) => void)?.(false);
    await vi.waitFor(() => {
      expect(mockSkillsServiceSetEnabled).toHaveBeenCalledWith({
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "remote:ssh:dev:/tmp/workspace",
        provider: "glm",
        scope: "user",
        skillId: "skill-1",
        enabled: false,
      });
      // 修复原因：protocol-v4 草稿没有 legacy draftSessionId，切换技能仍必须失效预热运行态。
      expect(invalidateDraftRuntimeMock).toHaveBeenCalledWith(
        "/tmp/workspace",
        "remote:ssh:dev:/tmp/workspace",
      );
      expect(useSkillStore.getState().skills[0]?.enabled).toBe(false);
    });
  });

  it("远程设置页切换技能开关不会刷新其他本地工作区的聊天补全缓存", async () => {
    const remoteSkill = {
      id: "skill-1",
      name: "lark-approval",
      description: "approval",
      body: "",
      path: "/root/.zcode/skills/lark-approval/SKILL.md",
      scope: "user" as const,
      enabled: true,
    };
    const localSkill = {
      id: "local-skill-1",
      name: "local-helper",
      description: "local",
      body: "",
      path: "/Users/alice/.zcode/skills/local-helper/SKILL.md",
      scope: "user" as const,
      enabled: true,
    };
    mockCapabilityState = { userScopeAvailable: true };
    mockSkillsState = [remoteSkill];
    activeScopeFilter = "user";
    mockSkillsServiceList.mockResolvedValue({
      skills: [{ ...remoteSkill, enabled: false }],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    const { useSkillStore } = await import("../src/store/skillStore.js");
    useSkillStore.setState({
      workspacePath: "/Users/alice/local-project",
      workspaceIdentity: null,
      loadedWorkspacePath: "/Users/alice/local-project",
      loadedWorkspaceIdentity: null,
      provider: "glm",
      loadedProvider: "glm",
      skills: [localSkill],
      capability: { userScopeAvailable: true },
      loading: false,
      error: null,
    });

    await renderSkillsSection();
    (capturedSwitches[0]?.onCheckedChange as (checked: boolean) => void)?.(false);
    await vi.waitFor(() => {
      expect(mockSkillsServiceSetEnabled).toHaveBeenCalled();
    });

    expect(useSkillStore.getState().workspacePath).toBe("/Users/alice/local-project");
    expect(useSkillStore.getState().skills).toEqual([localSkill]);
  });
});
