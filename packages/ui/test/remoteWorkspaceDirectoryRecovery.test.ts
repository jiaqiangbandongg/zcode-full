import { expect, it, vi } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type ReconnectRemoteWorkspaceOptions,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { reconnectRemoteWorkspaceGroup } from "@/root/useRemoteWorkspaceHistory.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";

type ReconnectParams = Parameters<typeof reconnectRemoteWorkspaceHistoryEntry>[0];

it("已删除项目发起 SSH 重连时，项目记为失败且不阻断两个 sibling", async () => {
  const entries: RemoteWorkspaceSessionEntry[] = [1, 2, 3].map((index) => ({
    kind: "remote",
    workspacePath: `/repo/${index}`,
    workspaceIdentity: `remote:server:fixture:/repo/${index}`,
    target: {
      kind: "ssh",
      host: "fixture.invalid",
      username: "tester",
      passwordCredentialKey: "fixture-password",
    },
    lastConnectionStatus: "connected",
    lastOpenedAt: 1,
  }));
  const unavailable = Object.assign(new Error("directory unavailable"), {
    code: "remote-workspace-directory-unavailable",
    retryable: false,
  });
  const upsert = vi.fn();
  const mutations = vi.fn<ReconnectParams["commitRemoteWorkspaceSessionMutation"]>(
    async (mutation) => mutation.entry,
  );
  const loadCredential = vi.fn(async () => "fixture-secret");
  const connect = vi.fn<ReconnectParams["connectRemoteWorkspaceTarget"]>(
    async (_target, _requestId, context) => {
      if (context?.workspacePath === "/repo/1") throw unavailable;
      return `session-${context?.workspacePath}`;
    },
  );
  const reconnectEntry = async (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => {
    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry: entry,
      options,
      activateTabByPath: () => true,
      setReconnectingRemoteWorkspaceKeys: () => undefined,
      loadCredential,
      connectRemoteWorkspaceTarget: connect,
      resolveRemoteWorkspaceCanonicalPath: async (_sessionId, path) => path,
      bindRemoteWorkspaceScope: async (_sessionId, workspacePath) => ({
        workspacePath,
        workspaceIdentity: `remote:server:fixture:${workspacePath}`,
      }),
      disposeRemoteWorkspaceSession: vi.fn(),
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab: upsert,
      commitRemoteWorkspaceSessionMutation: mutations,
      getRemoteSessions: () => entries,
      logger: { warn: vi.fn() },
      toast: vi.fn(),
    });
    return true;
  };
  await expect(
    reconnectRemoteWorkspaceGroup({
      selected: entries[0]!,
      reconnectGroup: entries,
      reconnectEntry,
      options: { throwOnFailure: true },
    }),
  ).rejects.toBe(unavailable);
  expect(connect.mock.calls.map(([, , context]) => context?.workspacePath)).toEqual([
    "/repo/1",
    "/repo/2",
    "/repo/3",
  ]);
  expect(mutations.mock.calls.map(([mutation]) => mutation.entry.lastConnectionStatus)).toEqual([
    "failed",
    "connected",
    "connected",
  ]);
  expect(upsert.mock.calls.map(([path]) => path)).toEqual(["/repo/2", "/repo/3"]);
  expect(loadCredential).toHaveBeenCalledTimes(1);
});

it("目录不可用错误沿用统一中英文消息映射", () => {
  expect(
    formatRemoteConnectionError({
      fallback: "raw ENOENT",
      reasonCode: "remote-workspace-directory-unavailable",
      retryable: false,
      formatMessage: ({ id }) => id,
    }),
  ).toBe("remote.error.workspaceDirectoryUnavailable");
});
