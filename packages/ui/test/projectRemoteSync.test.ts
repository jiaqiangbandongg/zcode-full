// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
const mocks = vi.hoisted(() => ({ sessions: {} as Record<string, unknown> }));
vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  useRemoteWorkspaceSessionStore: (select: (value: unknown) => unknown) =>
    select({ sessionsById: mocks.sessions }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ skillSyncService: {} }),
  useWorkspaceServicesResolution: () => ({ services: {}, rpcReady: true }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/settings/RemoteSyncActions.js", () => ({
  RemoteSyncDialogs: () => null,
  shouldShowRemoteSyncActions: ({ remoteSessionId, remoteTarget, clientMode }: any) =>
    clientMode !== "web-remote-replayable" &&
    !!remoteSessionId &&
    ["ssh", "wsl"].includes(remoteTarget?.kind),
}));
it("offers the original sync actions only for ready desktop SSH/WSL roots and drops disconnected intent", () => {
  const host = {
    id: "remote:server:s",
    membershipId: "m",
    kind: "ssh",
    target: { kind: "ssh", host: "example", username: "user" },
    connectionStatus: "online",
  };
  const project = {
    id: "p",
    hostId: host.id,
    name: "p",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  mocks.sessions = {
    s: { sessionId: "s", workspaceIdentity: "remote:server:s:/repo", workspacePath: "/repo" },
  };
  const { result, rerender } = renderHook(
    ({ mobile, online }) =>
      useProjectRemoteSync(
        { isWebRemoteControl: mobile } as never,
        {
          hosts: [{ ...host, connectionStatus: online ? "online" : "offline" }],
          entries: [],
        } as never,
      ),
    { initialProps: { mobile: false, online: true } },
  );
  expect(result.current.actions(project as never).map((action) => action.id)).toEqual([
    "sync-skills-0",
    "sync-mcp-0",
    "sync-plugins-0",
  ]);
  act(() => result.current.actions(project as never)[0]!.run());
  expect(result.current.dialog).not.toBeNull();
  rerender({ mobile: false, online: false });
  expect(result.current.dialog).toBeNull();
  rerender({ mobile: false, online: true });
  expect(result.current.dialog).toBeNull();
  rerender({ mobile: true, online: true });
  expect(result.current.actions(project as never)).toEqual([]);
});
