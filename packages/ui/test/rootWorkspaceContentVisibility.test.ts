import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppProps } from "@/app-shell/types.js";

const appRenderProps = vi.hoisted(() => [] as AppProps[]);

vi.mock("@/App.js", () => ({
  App: (props: AppProps) => {
    appRenderProps.push(props);
    return createElement("div", { "data-testid": "workspace-app" });
  },
}));

vi.mock("@/hooks/useServices.js", () => ({
  ServiceProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/root/WorkspaceSettingsLayer.js", () => ({
  WorkspaceSettingsLayer: () => createElement("div", { "data-testid": "settings-layer" }),
}));

function renderRootWorkspaceContent(
  isSettingsTabActive: boolean,
  params?: {
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
) {
  return import("@/root/RootWorkspaceContent.js").then(({ RootWorkspaceContent }) =>
    renderToStaticMarkup(
      createElement(RootWorkspaceContent, {
        workspaceScopedServices: {},
        workspaceShellPath: "/workspace/z-code",
        workspaceIdentity: params?.workspaceIdentity,
        workspaceRemoteSessionId: params?.workspaceRemoteSessionId,
        activeWorkspacePath: "/workspace/z-code",
        isSettingsTabActive,
        handleConnectRemote: vi.fn(),
        handleSelectRemoteProject: vi.fn(),
        handleCancelRemoteProject: vi.fn(),
        handleReconnectRemoteWorkspace: vi.fn(),
        handleCreateTask: vi.fn(),
        handleOpenWorkspace: vi.fn(),
        remoteWorkspaceSessions: [],
        handleBackFromSettings: vi.fn(),
        user: null,
        reconnectingRemoteWorkspaceKeys: [],
        remoteWorkspaceErrorByWorkspaceKey: {},
        reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
        allowOpenWorkspace: true,
      }),
    ),
  );
}

describe("RootWorkspaceContent", () => {
  beforeEach(() => {
    appRenderProps.length = 0;
  });

  it("keeps workspace layout mounted when settings is active so quickpick can stay visible", async () => {
    const html = await renderRootWorkspaceContent(true);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('data-root-workspace-surface="inert"');
    expect(html).toContain('inert=""');
    expect(html).not.toContain(" hidden ");
    expect(html).toContain('data-testid="workspace-app"');
    expect(html).toContain('data-testid="settings-layer"');
  });

  it("restores workspace interaction after settings closes", async () => {
    const html = await renderRootWorkspaceContent(false);

    expect(html).toContain('data-root-workspace-surface="interactive"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).not.toContain('inert=""');
  });

  it("keeps rendering App for a disconnected remote workspace", async () => {
    const workspaceIdentity = "remote:docker:zcode-ssh-linux-amd64:/root";
    const html = await renderRootWorkspaceContent(false, {
      workspaceIdentity,
    });

    expect(html).toContain('data-testid="workspace-app"');
    expect(html).not.toContain("workspace.disconnectedRemote.title");
    expect(appRenderProps[0]?.workspaceIdentity).toBe(workspaceIdentity);
  });
});
