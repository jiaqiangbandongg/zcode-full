// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteTarget } from "@zcode/shared";

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
  RemoteConnectionDirectoryStep,
  RemoteConnectionKindStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import { buildAvailableKinds } from "@/hooks/useRemoteConnectionForm.js";

afterEach(cleanup);

const allKinds: RemoteTarget["kind"][] = ["ssh", "server", "wsl", "docker"];

function KindStepHarness() {
  const [kind, setKind] = useState<RemoteTarget["kind"]>("ssh");
  const [settings, setSettings] = useState(false);
  return settings
    ? createElement("div", { "data-testid": "settings-kind" }, kind)
    : createElement(RemoteConnectionKindStep, {
        kind,
        availableKinds: allKinds,
        onKindChange: setKind,
        onNext: () => setSettings(true),
        onCancel: vi.fn(),
      });
}

describe("RemoteConnectionKindStep interactions", () => {
  it.each(allKinds)("double-click opens settings for %s", (kind) => {
    const view = render(createElement(KindStepHarness));
    const card = view.getByRole("button", {
      name: `remote.kind.${kind} remote.kind.${kind}.wizardDescription`,
    });

    fireEvent.click(card, { detail: 1 });
    expect(view.queryByTestId("settings-kind")).toBeNull();
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card, { detail: 2 });

    expect(view.getByTestId("settings-kind").textContent).toBe(kind);
  });

  it.each(allKinds)("single-click keeps %s selected until Next", (kind) => {
    const view = render(createElement(KindStepHarness));
    const card = view.getByRole("button", {
      name: `remote.kind.${kind} remote.kind.${kind}.wizardDescription`,
    });

    fireEvent.click(card);
    expect(view.queryByTestId("settings-kind")).toBeNull();
    expect(card.classList.contains("bg-selected")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "common.next" }));

    expect(view.getByTestId("settings-kind").textContent).toBe(kind);
  });
});

describe("RemoteConnectionDialogContent layout", () => {
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

  it("renders the kind chooser as compact tiles", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionKindStep, {
        kind: "ssh",
        availableKinds: ["ssh", "server", "wsl", "docker"],
        onKindChange: vi.fn(),
        onCancel: vi.fn(),
        onNext: vi.fn(),
      }),
    );

    expect(html).toContain("md:grid-cols-2");
    expect(html).not.toContain("lg:grid-cols-3");
    expect(html).toContain("min-h-32");
    expect(html).toContain("text-ui-lg font-medium");
  });

  it("keeps the settings fields in their own scroll area above footer actions", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionSettingsStep, {
        kind: "ssh",
        host: "example.com",
        port: "22",
        username: "user",
        sshAuthMethod: "privateKey",
        assetInstallMode: "local",
        password: "",
        privateKeyPath: "/Users/test/.ssh/id_rsa",
        privateKeyPassphrase: "",
        wslDistro: "",
        wslDistros: [],
        dockerContainer: "",
        manualDockerContainer: "",
        serverUrl: "",
        serverName: "",
        serverToken: "",
        serverWorkspacePath: "",
        dockerContainers: [],
        dockerAvailable: null,
        sshConfigAliases: [],
        sshConfigAliasesLoading: false,
        sshConfigAliasesError: "",
        selectedSshConfigAlias: null,
        currentRuntimeOptionsLoading: false,
        currentRuntimeOptionsError: "",
        remoteWorkspaceSessions: [],
        validationMessage: "",
        loading: false,
        onBack: vi.fn(),
        onHostChange: vi.fn(),
        onPortChange: vi.fn(),
        onUsernameChange: vi.fn(),
        onSshAuthMethodChange: vi.fn(),
        onAssetInstallModeChange: vi.fn(),
        onPasswordChange: vi.fn(),
        onPrivateKeyPathChange: vi.fn(),
        onPrivateKeyPassphraseChange: vi.fn(),
        onWslDistroChange: vi.fn(),
        onDockerContainerChange: vi.fn(),
        onManualDockerContainerChange: vi.fn(),
        onServerUrlChange: vi.fn(),
        onServerNameChange: vi.fn(),
        onServerTokenChange: vi.fn(),
        onServerWorkspacePathChange: vi.fn(),
        onApplySshConfigAlias: vi.fn(),
        onClearSelectedSshConfigAlias: vi.fn(),
        onConnect: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="remote-connection-settings-scroll"');
    expect(html).toContain("overflow-y-auto");
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

  it("shows one sync dropdown action after connecting to an SSH host", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
        },
        localSkillSyncService: {} as never,
        remoteSkillSyncService: {} as never,
        localMcpSyncService: {} as never,
        remoteMcpSyncService: {} as never,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("settings.remoteSync.open");
    expect(html).not.toContain("settings.skills.remoteSync.open");
    expect(html).not.toContain("settings.mcp.remoteSync.open");
  });

  it("shows one sync dropdown action after connecting to a WSL distro", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        remoteTarget: {
          kind: "wsl",
          distro: "Ubuntu",
          user: "alice",
        },
        localSkillSyncService: {} as never,
        remoteSkillSyncService: {} as never,
        localMcpSyncService: {} as never,
        remoteMcpSyncService: {} as never,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("settings.remoteSync.open");
    expect(html).not.toContain("settings.skills.remoteSync.open");
    expect(html).not.toContain("settings.mcp.remoteSync.open");
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
