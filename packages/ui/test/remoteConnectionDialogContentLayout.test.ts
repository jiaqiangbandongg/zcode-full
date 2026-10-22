// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const capturedRemoteSyncDialogProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: () => createElement("div", { "data-testid": "directory-browser" }),
}));

vi.mock("@/RemoteConnectionFields.js", () => ({
  RemoteConnectionFields: () => createElement("div", { "data-testid": "remote-connection-fields" }),
}));

vi.mock("@/settings/RemoteSyncActions.js", () => ({
  RemoteSyncDialogs: (props: Record<string, unknown>) => {
    capturedRemoteSyncDialogProps.push(props);
    return createElement("div", { "data-testid": "remote-sync-dialogs" });
  },
  RemoteSyncDropdownButton: () =>
    createElement("button", { type: "button" }, "settings.remoteSync.open"),
  shouldShowRemoteSyncActions: ({
    remoteSessionId,
    remoteTarget,
  }: {
    remoteSessionId?: string | null;
    remoteTarget?: { kind: string } | null;
  }) => Boolean(remoteSessionId?.trim() && ["ssh", "wsl"].includes(remoteTarget?.kind ?? "")),
}));

import {
  getRecentRemoteWorkspaceHistory,
  RemoteConnectionDirectoryStep,
} from "@/RemoteConnectionDialogContent.js";
import { buildAvailableKinds } from "@/hooks/useRemoteConnectionForm.js";

describe("RemoteConnectionDialogContent layout", () => {
  it("shows the most recently opened directories first", () => {
    expect(
      getRecentRemoteWorkspaceHistory([
        {
          workspacePath: "/old",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 1,
        },
        {
          workspacePath: "/new",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 3,
        },
        {
          workspacePath: "/middle",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 2,
        },
      ]).map((entry) => entry.workspacePath),
    ).toEqual(["/new", "/middle", "/old"]);
  });

  it("filters hidden directories out of the recent list", () => {
    expect(
      getRecentRemoteWorkspaceHistory([
        {
          workspacePath: "/home/dev/.zcode",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 9,
        },
        {
          workspacePath: "/home/dev/work",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 1,
        },
      ]).map((entry) => entry.workspacePath),
    ).toEqual(["/home/dev/work"]);
  });

  it("filters the Source conversation backing path out of recent directories", () => {
    expect(
      getRecentRemoteWorkspaceHistory(
        [
          {
            workspacePath: "/remote/.zcode/workspace/default",
            sourceServerId: "source-1",
            profileId: "p",
            lastOpenedAt: 3,
          },
          {
            workspacePath: "/remote/project",
            sourceServerId: "source-1",
            profileId: "p",
            lastOpenedAt: 2,
          },
        ],
        {
          "source-1": {
            workspacePath: "/remote/.zcode/workspace/default",
            lastResolvedAt: 4,
          },
        },
      ).map((entry) => entry.workspacePath),
    ).toEqual(["/remote/project"]);
  });

  it("renders full quick-open paths", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        selecting: false,
        quickOpenPaths: ["/home/dev/work/api"],
        deviceName: "dev",
        onRenameDevice: vi.fn(),
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("/home/dev/work/api");
    expect(html).toContain("remote.recentDirectories");
  });

  it("shows Server between SSH and Windows-only kinds in local development", () => {
    expect(
      buildAvailableKinds({
        isWindowsDesktop: true,
        isLocalDevelopmentRuntime: true,
      }),
    ).toEqual(["ssh", "server", "wsl", "docker"]);
  });

  it("hides Server from production-mode packaged runtimes", () => {
    expect(
      buildAvailableKinds({
        isWindowsDesktop: true,
        isLocalDevelopmentRuntime: false,
      }),
    ).toEqual(["ssh", "wsl", "docker"]);
    expect(
      buildAvailableKinds({
        isWindowsDesktop: false,
        isLocalDevelopmentRuntime: false,
      }),
    ).toEqual(["ssh", "docker"]);
  });

  it("shows progress feedback while finalizing a selected remote directory", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        selecting: true,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("common.loading");
    expect(html).toContain("animate-spin");
  });

  it("passes the local workspace path to MCP sync from the directory step", () => {
    capturedRemoteSyncDialogProps.length = 0;

    renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
        },
        localWorkspacePath: "/Users/alice/project",
        localMcpSyncService: {} as never,
        remoteMcpSyncService: {} as never,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(capturedRemoteSyncDialogProps[0]?.mcpLocalWorkspacePath).toBe("/Users/alice/project");
  });
});
