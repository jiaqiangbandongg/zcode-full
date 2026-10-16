import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuSub: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuSubTrigger: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("div", props, children),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("div", props, children),
  DropdownMenuCheckboxItem: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("div", props, children),
  DropdownMenuSeparator: () => createElement("hr"),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/SSHDialog.js", () => ({
  SSHDialog: () => createElement("div", { "data-testid": "ssh-dialog" }),
}));

async function renderMenu(
  showRemoteConnectionEntry: boolean,
  allowRemoteWorkspace = true,
) {
  vi.resetModules();
  vi.doMock("@/hooks/useRemoteConnectionEntryVisibility.js", () => ({
    useRemoteConnectionEntryVisibility: () => showRemoteConnectionEntry,
  }));
  vi.doMock("@zcode/shared", async () => {
    const actual = await vi.importActual<typeof import("@zcode/shared")>(
      "@zcode/shared"
    );
    return {
      ...actual,
    };
  });

  const { ChatEmptyWorkspacePreviewMenu } = await import("../src/ChatEmptyState.js");
  const Menu = ChatEmptyWorkspacePreviewMenu as unknown as ComponentType<
    Record<string, unknown>
  >;
  return renderToStaticMarkup(
    createElement(Menu, {
      workspacePath: "/Users/tester/project",
      workspaceTabs: [
        {
          workspacePath: "/Users/tester/project",
          label: "project",
        },
      ],
      onSelectWorkspace: vi.fn(),
      onSelectConversationWorkspace: vi.fn(),
      onOpenFolder: vi.fn(),
      allowRemoteWorkspace,
      onConnectRemote: async () => "session-id",
      onSelectRemoteProject: async () => {},
      onCancelRemoteProject: async () => {},
    }),
  );
}

afterEach(() => {
  vi.resetModules();
});

describe("ChatEmptyWorkspacePreviewMenu", () => {
  it("同路径远程项目按 workspaceIdentity 判定唯一选中项", async () => {
    const { isWorkspaceMenuTabSelected } = await import("../src/ChatEmptyState.js");
    const remoteA = {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:a:/repo",
      label: "remote-a",
    };
    const remoteB = {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:b:/repo",
      label: "remote-b",
    };

    expect(
      isWorkspaceMenuTabSelected(remoteA, {
        workspacePath: "/repo",
        workspaceIdentity: remoteB.workspaceIdentity,
      }),
    ).toBe(false);
    expect(
      isWorkspaceMenuTabSelected(remoteB, {
        workspacePath: "/repo",
        workspaceIdentity: remoteB.workspaceIdentity,
      }),
    ).toBe(true);
  });

  it("工作区搜索最多保留前 5 条且保持原顺序", async () => {
    const {
      filterVisibleWorkspaceMenuTabs,
    } = await import("../src/ChatEmptyState.js");
    const tabs = [
      "/workspace/alpha",
      "/workspace/beta",
      "/workspace/gamma",
      "/workspace/delta",
      "/workspace/epsilon",
      "/workspace/zeta",
    ].map((workspacePath) => ({
      workspacePath,
      label: workspacePath.split("/").pop()!,
    }));

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "",
      }).map((tab) => tab.label),
    ).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "workspace",
      }).map((tab) => tab.label),
    ).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
  });

  it("工作区搜索匹配名称、路径和远程目标信息", async () => {
    const {
      filterVisibleWorkspaceMenuTabs,
    } = await import("../src/ChatEmptyState.js");
    const tabs = [
      {
        workspacePath: "/repo/alpha",
        label: "Alpha",
      },
      {
        workspacePath: "/remote/project",
        label: "Remote Project",
        remoteSessionId: "remote-1",
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          port: 2222,
          username: "alice",
        },
      },
      {
        workspacePath: "/repo/by-path",
        label: "Path Match",
      },
    ] as const;

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "alpha",
      }).map((tab) => tab.label),
    ).toEqual(["Alpha"]);

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "by-path",
      }).map((tab) => tab.label),
    ).toEqual(["Path Match"]);

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "dev.example.com",
      }).map((tab) => tab.label),
    ).toEqual(["Remote Project"]);
  });

  it("工作区搜索没有匹配项时保留新增工作区入口", async () => {
    const {
      filterVisibleWorkspaceMenuTabs,
      ChatEmptyWorkspacePreviewMenu,
    } = await import("../src/ChatEmptyState.js");
    const tabs = [
      {
        workspacePath: "/repo/alpha",
        label: "Alpha",
      },
    ];

    expect(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: tabs,
        homeWorkspaceLabel: "Home",
        searchQuery: "missing",
      }),
    ).toEqual([]);

    const Menu = ChatEmptyWorkspacePreviewMenu as unknown as ComponentType<
      Record<string, unknown>
    >;
    const html = renderToStaticMarkup(
      createElement(Menu, {
        workspacePath: "/Users/tester/project",
        workspaceTabs: [],
        onSelectWorkspace: vi.fn(),
        onSelectConversationWorkspace: vi.fn(),
        onOpenFolder: vi.fn(),
        allowRemoteWorkspace: false,
        onConnectRemote: async () => "session-id",
        onSelectRemoteProject: async () => {},
        onCancelRemoteProject: async () => {},
      }),
    );

    expect(html).toContain("chat.empty.workspaceSearchEmpty");
    expect(html).toContain("workspace.openFolder");
  });

  it("隐藏 Home 快捷项并展示 Open folder 入口", async () => {
    const html = await renderMenu(false);

    expect(html).not.toContain("chat.empty.home");
    expect(html).not.toContain("workspace.openWorkspace");
    expect(html).toContain("workspace.openFolder");
  });

  it("Start from scratch 默认路径为空名称后缀，非法名称有校验", async () => {
    const {
      getScratchWorkspaceLocationHint,
      getScratchWorkspaceNameErrorKind,
    } = await import("../src/ChatEmptyState.js");

    expect(getScratchWorkspaceLocationHint("")).toBe("~/ZCodeProject/");
    expect(getScratchWorkspaceLocationHint("demo")).toBe("~/ZCodeProject/demo");
    expect(getScratchWorkspaceNameErrorKind("")).toBe("required");
    expect(getScratchWorkspaceNameErrorKind("bad/name")).toBe("separator");
    expect(getScratchWorkspaceNameErrorKind("bad\\name")).toBe("separator");
    expect(getScratchWorkspaceNameErrorKind("demo")).toBeNull();
  });

  it("在允许远程入口时展示远程连接项", async () => {
    const html = await renderMenu(true);

    expect(html).toContain("remote.trigger");
  });

  it("workspace 菜单提供不在项目中工作入口", async () => {
    const html = await renderMenu(false);

    expect(html).toContain("chat.empty.workOutsideProject");
  });

  it("对话工作区显示选择项目且不展示关闭按钮", async () => {
    const { ChatEmptyWorkspacePreviewMenu } =
      await import("../src/ChatEmptyState.js");
    const Menu = ChatEmptyWorkspacePreviewMenu as unknown as ComponentType<
      Record<string, unknown>
    >;
    const html = renderToStaticMarkup(
      createElement(Menu, {
        workspacePath: "/Users/tester/.zcode/workspace/default",
        workspaceTabs: [
          {
            workspacePath: "/Users/tester/.zcode/workspace/default",
            label: "default",
            workspacePurpose: "conversation",
          },
        ],
        onSelectWorkspace: vi.fn(),
        onSelectConversationWorkspace: vi.fn(),
        onOpenFolder: vi.fn(),
        allowRemoteWorkspace: false,
        onConnectRemote: async () => "session-id",
        onSelectRemoteProject: async () => {},
        onCancelRemoteProject: async () => {},
      }),
    );

    expect(html).toContain("chat.empty.selectProject");
    expect(html).not.toContain("chat.empty.detachProject");
  });

  it("可单独保留不在项目中工作菜单项并关闭项目 chip 的脱离按钮", async () => {
    const { ChatEmptyWorkspacePreviewMenu } =
      await import("../src/ChatEmptyState.js");
    const Menu = ChatEmptyWorkspacePreviewMenu as unknown as ComponentType<
      Record<string, unknown>
    >;
    const html = renderToStaticMarkup(
      createElement(Menu, {
        workspacePath: "/Users/tester/project",
        workspaceTabs: [
          {
            workspacePath: "/Users/tester/.zcode/workspace/default",
            label: "default",
            workspacePurpose: "conversation",
          },
          {
            workspacePath: "/Users/tester/project",
            label: "project",
          },
        ],
        allowConversationWorkspaceSelection: true,
        allowConversationWorkspaceDetach: false,
        onSelectWorkspace: vi.fn(),
        onSelectConversationWorkspace: vi.fn(),
        onOpenFolder: vi.fn(),
        allowOpenWorkspace: false,
        allowRemoteWorkspace: false,
        onConnectRemote: async () => "session-id",
        onSelectRemoteProject: async () => {},
        onCancelRemoteProject: async () => {},
      }),
    );

    expect(html).toContain("chat.empty.workOutsideProject");
    expect(html).toContain("lucide-message-circle");
    expect(html).not.toContain(">default<");
    expect(html).not.toContain("chat.empty.detachProject");
    expect(html).not.toContain("group-hover/workspace-chip:opacity-0");
  });

  it("禁用非项目工作区能力时同时隐藏脱离按钮和菜单项", async () => {
    const { ChatEmptyWorkspacePreviewMenu } =
      await import("../src/ChatEmptyState.js");
    const Menu = ChatEmptyWorkspacePreviewMenu as unknown as ComponentType<
      Record<string, unknown>
    >;
    const props = {
      workspacePath: "/Users/tester/project",
      workspaceTabs: [
        {
          workspacePath: "/Users/tester/project",
          label: "project",
        },
      ],
      onSelectWorkspace: vi.fn(),
      onSelectConversationWorkspace: vi.fn(),
      onOpenFolder: vi.fn(),
      allowRemoteWorkspace: false,
      onConnectRemote: async () => "session-id",
      onSelectRemoteProject: async () => {},
      onCancelRemoteProject: async () => {},
    };

    const defaultHtml = renderToStaticMarkup(createElement(Menu, props));
    const hiddenHtml = renderToStaticMarkup(
      createElement(Menu, {
        ...props,
        allowConversationWorkspaceSelection: false,
      }),
    );

    expect(defaultHtml).toContain("chat.empty.detachProject");
    expect(defaultHtml).toContain("chat.empty.workOutsideProject");
    expect(defaultHtml).toContain("group-hover/workspace-chip:opacity-0");
    expect(defaultHtml).toContain("group-focus-within/workspace-chip:opacity-0");
    expect(hiddenHtml).not.toContain("chat.empty.detachProject");
    expect(hiddenHtml).not.toContain("chat.empty.workOutsideProject");
    expect(hiddenHtml).not.toContain("group-hover/workspace-chip:opacity-0");
    expect(hiddenHtml).not.toContain("group-focus-within/workspace-chip:opacity-0");
  });

  it("普通会话 hover workspace trigger 时隐藏项目图标供关闭按钮替换", async () => {
    const html = await renderMenu(false);

    expect(html).toContain("group-hover/workspace-chip:opacity-0");
    expect(html).toContain("group-focus-within/workspace-chip:opacity-0");
  });

  it("在不允许远程入口时隐藏远程连接项", async () => {
    const html = await renderMenu(false);

    expect(html).not.toContain("remote.trigger");
  });

  it("在 Web 本地模式关闭远程能力时隐藏远程连接项", async () => {
    const html = await renderMenu(true, false);

    expect(html).not.toContain("remote.trigger");
    expect(html).not.toContain("ssh-dialog");
  });
});
