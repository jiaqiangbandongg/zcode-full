// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { capturedSkillDialogProps, capturedMcpDialogProps, capturedPluginDialogProps } = vi.hoisted(() => ({
  capturedSkillDialogProps: [] as Array<Record<string, unknown>>,
  capturedMcpDialogProps: [] as Array<Record<string, unknown>>,
  capturedPluginDialogProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ChevronDown: createIcon("chevron-down"),
    UploadCloud: createIcon("upload-cloud"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => createElement("div", { "data-testid": "dropdown-menu-content", ...props }, children),
  DropdownMenuItem: ({
    children,
    disabled,
    ...props
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-disabled": disabled ? "true" : undefined,
        "data-testid": "dropdown-menu-item",
        ...props,
      },
      children,
    ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "settings.skills.remoteSync.open": "同步 Skill",
          "settings.mcp.remoteSync.open": "同步 MCP",
          "settings.plugins.remoteSync.open": "同步 Plugin",
          "settings.remoteSync.open": "同步",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/settings/RemoteSkillSyncDialog.js", () => ({
  RemoteSkillSyncDialog: (props: Record<string, unknown>) => {
    capturedSkillDialogProps.push(props);
    return createElement("div", { "data-testid": "remote-skill-sync-dialog" });
  },
}));

vi.mock("@/settings/RemoteMcpSyncDialog.js", () => ({
  RemoteMcpSyncDialog: (props: Record<string, unknown>) => {
    capturedMcpDialogProps.push(props);
    return createElement("div", { "data-testid": "remote-mcp-sync-dialog" });
  },
}));

vi.mock("@/settings/RemotePluginSyncDialog.js", () => ({
  RemotePluginSyncDialog: (props: Record<string, unknown>) => {
    capturedPluginDialogProps.push(props);
    return createElement("div", { "data-testid": "remote-plugin-sync-dialog" });
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteSyncActions", () => {
  it("drops dialog intent across disconnects and remote target changes", async () => {
    const { useRemoteSyncDialogIntent } = await import(
      "@/settings/RemoteSyncActions.js"
    );
    const hook = renderHook(
      ({ rpcReady, targetKey }) =>
        useRemoteSyncDialogIntent({ rpcReady, targetKey }),
      {
        initialProps: {
          rpcReady: true,
          targetKey: "remote-a:session-1",
        },
      },
    );

    act(() => hook.result.current.setOpen(true));
    expect(hook.result.current.open).toBe(true);

    hook.rerender({ rpcReady: false, targetKey: "remote-a:session-1" });
    expect(hook.result.current.open).toBe(false);

    hook.rerender({ rpcReady: true, targetKey: "remote-a:session-2" });
    expect(hook.result.current.open).toBe(false);

    act(() => hook.result.current.setOpen(true));
    expect(hook.result.current.open).toBe(true);

    hook.rerender({ rpcReady: true, targetKey: "remote-b:session-3" });
    expect(hook.result.current.open).toBe(false);
  });

  it("shows remote sync actions for SSH and WSL sessions only", async () => {
    const { shouldShowRemoteSyncActions } = await import("@/settings/RemoteSyncActions.js");

    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: "session-ssh",
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
        },
      }),
    ).toBe(true);
    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: "session-wsl",
        remoteTarget: {
          kind: "wsl",
          distro: "Ubuntu",
          user: "alice",
        },
      }),
    ).toBe(true);
    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: "session-docker",
        remoteTarget: {
          kind: "docker",
          container: "devbox",
        },
      }),
    ).toBe(false);
    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: null,
        remoteTarget: {
          kind: "wsl",
          distro: "Ubuntu",
        },
      }),
    ).toBe(false);
  });

  it("hides remote sync actions in Web remote replayable contexts", async () => {
    const { shouldShowRemoteSyncActions } = await import("@/settings/RemoteSyncActions.js");

    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: "session-wsl",
        remoteTarget: {
          kind: "wsl",
          distro: "Ubuntu",
          user: "alice",
        },
        clientMode: "web-remote-replayable",
        hasLocalSourceService: true,
      }),
    ).toBe(false);
  });

  it("hides remote sync actions when the desktop local source service is unavailable", async () => {
    const { shouldShowRemoteSyncActions } = await import("@/settings/RemoteSyncActions.js");

    expect(
      shouldShowRemoteSyncActions({
        remoteSessionId: "session-wsl",
        remoteTarget: {
          kind: "wsl",
          distro: "Ubuntu",
        },
        clientMode: "desktop-continuous",
        hasLocalSourceService: false,
      }),
    ).toBe(false);
  });

  it("allows starting a remote sync operation only when selection exists and no run is active", async () => {
    const { shouldStartRemoteSyncOperation } = await import("@/settings/RemoteSyncActions.js");

    expect(shouldStartRemoteSyncOperation({ inFlight: false, selectedCount: 1 })).toBe(true);
    expect(shouldStartRemoteSyncOperation({ inFlight: true, selectedCount: 1 })).toBe(false);
    expect(shouldStartRemoteSyncOperation({ inFlight: false, selectedCount: 0 })).toBe(false);
  });

  it("times out a remote sync preflight that never resolves", async () => {
    vi.useFakeTimers();
    const {
      isRemoteSyncPreflightTimeoutError,
      REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
      runRemoteSyncPreflightWithTimeout,
    } = await import("@/settings/RemoteSyncActions.js");

    const result = runRemoteSyncPreflightWithTimeout(
      () => new Promise<string>(() => undefined),
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS);
    const error = await result;

    expect(isRemoteSyncPreflightTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({
      timeoutMs: REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
    });
  });

  it("clears the remote sync preflight timeout after a successful response", async () => {
    vi.useFakeTimers();
    const { REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS, runRemoteSyncPreflightWithTimeout } =
      await import("@/settings/RemoteSyncActions.js");

    await expect(
      runRemoteSyncPreflightWithTimeout(async () => "ok"),
    ).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS);
  });

  it("renders Skill, MCP, and Plugin menu actions for SSH remote contexts", async () => {
    const { RemoteSyncMenuItems } = await import("@/settings/RemoteSyncActions.js");

    const html = renderToStaticMarkup(
      createElement(RemoteSyncMenuItems, {
        canSyncSkills: true,
        canSyncMcp: true,
        canSyncPlugins: true,
        onOpenSkillSync: vi.fn(),
        onOpenMcpSync: vi.fn(),
        onOpenPluginSync: vi.fn(),
      }),
    );

    expect(html).toContain("同步 Skill");
    expect(html).toContain("同步 MCP");
    expect(html).toContain("同步 Plugin");
    expect(html.match(/data-icon="upload-cloud"/g)?.length).toBe(3);
  });

  it("renders one sync dropdown button with Skill, MCP, and Plugin actions", async () => {
    const { RemoteSyncDropdownButton } = await import("@/settings/RemoteSyncActions.js");

    const html = renderToStaticMarkup(
      createElement(RemoteSyncDropdownButton, {
        canSyncSkills: true,
        canSyncMcp: true,
        canSyncPlugins: true,
        onOpenSkillSync: vi.fn(),
        onOpenMcpSync: vi.fn(),
        onOpenPluginSync: vi.fn(),
      }),
    );

    expect(html).toContain("同步");
    expect(html).toContain("同步 Skill");
    expect(html).toContain("同步 MCP");
    expect(html).toContain("同步 Plugin");
    expect(html.match(/data-testid="dropdown-menu-item"/g)?.length).toBe(3);
    expect(html.match(/data-icon="upload-cloud"/g)?.length).toBe(4);
    expect(html).toContain('data-icon="chevron-down"');
  });

  it("keeps the MCP dropdown action disabled until a remote workspace path exists", async () => {
    const { RemoteSyncDropdownButton } = await import("@/settings/RemoteSyncActions.js");

    const html = renderToStaticMarkup(
      createElement(RemoteSyncDropdownButton, {
        canSyncSkills: true,
        canSyncMcp: true,
        canSyncPlugins: true,
        mcpDisabled: true,
        onOpenSkillSync: vi.fn(),
        onOpenMcpSync: vi.fn(),
        onOpenPluginSync: vi.fn(),
      }),
    );

    expect(html).toContain("同步 Skill");
    expect(html).toContain("同步 MCP");
    expect(html).toContain("同步 Plugin");
    expect(html).toContain('data-disabled="true"');
  });

  it("mounts all remote sync dialogs while preserving distinct workspace paths", async () => {
    const { RemoteSyncDialogs } = await import("@/settings/RemoteSyncActions.js");
    capturedSkillDialogProps.length = 0;
    capturedMcpDialogProps.length = 0;
    capturedPluginDialogProps.length = 0;
    const localZCodeAgentService = {};
    const remoteZCodeAgentService = {};

    renderToStaticMarkup(
      createElement(RemoteSyncDialogs, {
        canSyncSkills: true,
        canSyncMcp: true,
        canSyncPlugins: true,
        skillOpen: true,
        mcpOpen: true,
        pluginOpen: true,
        onSkillOpenChange: vi.fn(),
        onMcpOpenChange: vi.fn(),
        onPluginOpenChange: vi.fn(),
        localSkillSyncService: {} as never,
        remoteSkillSyncService: {} as never,
        localMcpSyncService: {} as never,
        remoteMcpSyncService: {} as never,
        localPluginSyncService: {} as never,
        remotePluginSyncService: {} as never,
        localZCodeAgentService: localZCodeAgentService as never,
        remoteZCodeAgentService: remoteZCodeAgentService as never,
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
        },
        skillWorkspacePath: "",
        mcpWorkspacePath: "/root/folder1",
        pluginWorkspacePath: "/root/folder1",
        pluginLocalWorkspacePath: "/Users/me/folder1",
        mcpLocalWorkspacePath: "/Users/me/folder1",
        workspaceIdentity: "remote:ssh:localhost:2223:root:/root/folder1",
        onSkillsSynced: vi.fn(),
        onMcpSynced: vi.fn(),
        onPluginsSynced: vi.fn(),
      }),
    );

    expect(capturedSkillDialogProps).toHaveLength(1);
    expect(capturedMcpDialogProps).toHaveLength(1);
    expect(capturedPluginDialogProps).toHaveLength(1);
    expect(capturedSkillDialogProps[0]?.workspacePath).toBe("");
    expect(capturedMcpDialogProps[0]?.workspacePath).toBe("/root/folder1");
    expect(capturedPluginDialogProps[0]?.workspacePath).toBe("/root/folder1");
    expect(capturedPluginDialogProps[0]?.localWorkspacePath).toBe("/Users/me/folder1");
    expect(capturedPluginDialogProps[0]?.localZCodeAgentService).toBe(localZCodeAgentService);
    expect(capturedPluginDialogProps[0]?.remoteZCodeAgentService).toBe(remoteZCodeAgentService);
    expect(capturedMcpDialogProps[0]?.localWorkspacePath).toBe("/Users/me/folder1");
    expect(capturedSkillDialogProps[0]?.workspaceIdentity).toBe(
      "remote:ssh:localhost:2223:root:/root/folder1",
    );
    expect(capturedPluginDialogProps[0]?.workspaceIdentity).toBe(
      "remote:ssh:localhost:2223:root:/root/folder1",
    );
  });
});
