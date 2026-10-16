import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  createProjectId,
  createSessionId,
  type SessionInfo,
  type SessionStorePort,
  type UpdateSessionInput,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  REMOTE_SESSION_PATH_CORRUPTION_REASON,
  repairPersistedRemoteSessionPaths,
} from "../src/runtime/helpers/persisted-remote-session-path-repair.js";

function createSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: createSessionId("remote-path-repair"),
    projectID: createProjectId("remote-path-repair"),
    workspaceID: "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId,
    taskType: "interactive",
    slug: "remote-path-repair",
    directory: "/home/dev/project",
    path: "/home/dev/project",
    title: "Remote path repair",
    version: "0.1.0",
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function createUpdater(session: SessionInfo) {
  let persisted = session;
  const updateSession = vi.fn(
    async (input: UpdateSessionInput): Promise<SessionInfo> => ({
      ...session,
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
      ...(input.path !== undefined ? { path: input.path === null ? undefined : input.path } : {}),
    }),
  );
  const repairRemoteSessionPaths = vi.fn(
    async (input: {
      sessionID: SessionInfo["id"];
      workspaceID: WorkspaceId;
      expectedDirectory: string;
      expectedPath: string | null;
      directory: string;
      path: string | null;
      timeUpdated: number;
    }): Promise<boolean> => {
      persisted = {
        ...persisted,
        directory: input.directory,
        ...(input.path === null ? { path: undefined } : { path: input.path }),
      };
      return true;
    },
  );
  const getSession = vi.fn(async () => persisted);
  return {
    store: { getSession, repairRemoteSessionPaths, updateSession } as Pick<
      SessionStorePort,
      "getSession" | "updateSession"
    > & { repairRemoteSessionPaths: typeof repairRemoteSessionPaths },
    getSession,
    repairRemoteSessionPaths,
    updateSession,
  };
}

describe("repairPersistedRemoteSessionPaths", () => {
  it("repairs and persists the known WSL identity-appended paths", async () => {
    const identity = "remote:wsl:Debian:dev:/home/dev/project";
    const polluted = `/home/dev/project/${identity}`;
    const session = createSession({ directory: polluted, path: polluted });
    const { store, repairRemoteSessionPaths, updateSession } = createUpdater(session);

    const repaired = await repairPersistedRemoteSessionPaths(store, session);

    expect(repairRemoteSessionPaths).toHaveBeenCalledWith({
      sessionID: session.id,
      workspaceID: session.workspaceID,
      expectedDirectory: polluted,
      expectedPath: polluted,
      directory: "/home/dev/project",
      path: "/home/dev/project",
      timeUpdated: session.time.updated,
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(repaired).toMatchObject({ directory: "/home/dev/project", path: "/home/dev/project" });
  });

  it("repairs the identity-only cwd form for SSH sessions", async () => {
    const identity = "remote:ssh:dev.example.com:22:dev:/srv/project";
    const session = createSession({
      workspaceID: identity as WorkspaceId,
      directory: identity,
      path: "/srv/project",
    });
    const { store, repairRemoteSessionPaths, updateSession } = createUpdater(session);

    await repairPersistedRemoteSessionPaths(store, session);

    expect(repairRemoteSessionPaths).toHaveBeenCalledWith({
      sessionID: session.id,
      workspaceID: session.workspaceID,
      expectedDirectory: identity,
      expectedPath: "/srv/project",
      directory: "/srv/project",
      path: "/srv/project",
      timeUpdated: session.time.updated,
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("continues with the in-memory repair when persistence fails", async () => {
    const identity = "remote:wsl:Debian:dev:/home/dev/project";
    const polluted = `/home/dev/project/${identity}`;
    const session = createSession({ directory: polluted, path: polluted });
    const persistenceError = new Error("database is locked");
    const onPersistenceFailure = vi.fn();
    const updateSession = vi.fn(async (): Promise<SessionInfo> => session);
    const repairRemoteSessionPaths = vi.fn(async (): Promise<boolean> => {
      throw persistenceError;
    });

    const repaired = await repairPersistedRemoteSessionPaths(
      {
        getSession: vi.fn(async () => session),
        repairRemoteSessionPaths,
        updateSession,
      } as Pick<SessionStorePort, "getSession" | "updateSession"> & {
        repairRemoteSessionPaths: typeof repairRemoteSessionPaths;
      },
      session,
      { onPersistenceFailure },
    );

    expect(repaired).toMatchObject({ directory: "/home/dev/project", path: "/home/dev/project" });
    expect(onPersistenceFailure).toHaveBeenCalledWith(persistenceError);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("re-reads a CAS miss and keeps metadata from a concurrent successful repair", async () => {
    const identity = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    const session = createSession({ directory: identity, path: identity });
    const concurrent = createSession({
      directory: "/home/dev/project",
      path: "/home/dev/project",
      title: "并发更新后的标题",
      time: { ...session.time, updated: 99 },
    });
    const updateSession = vi.fn(async (): Promise<SessionInfo> => session);
    const repairRemoteSessionPaths = vi.fn(async () => false);
    const getSession = vi.fn(async () => concurrent);

    const repaired = await repairPersistedRemoteSessionPaths(
      { getSession, repairRemoteSessionPaths, updateSession } as Pick<
        SessionStorePort,
        "getSession" | "updateSession"
      > & { repairRemoteSessionPaths: typeof repairRemoteSessionPaths },
      session,
    );

    expect(repaired).toBe(concurrent);
    expect(repaired.title).toBe("并发更新后的标题");
    expect(getSession).toHaveBeenCalledWith(session.id);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("leaves clean, local, and unrelated remote subdirectory paths unchanged", async () => {
    const sessions = [
      createSession(),
      createSession({ workspaceID: undefined, directory: "C:\\project" }),
      createSession({
        directory: "/home/dev/project/packages/core",
        path: "/home/dev/project/packages/core",
      }),
    ];
    for (const session of sessions) {
      const { store, updateSession } = createUpdater(session);
      await expect(repairPersistedRemoteSessionPaths(store, session)).resolves.toBe(session);
      expect(updateSession).not.toHaveBeenCalled();
    }
  });

  it("reports ambiguous identity contamination as session corruption", async () => {
    const identity = "remote:wsl:Debian:dev:/home/dev/project";
    const session = createSession({ directory: `/unexpected/prefix/${identity}` });
    const { store, updateSession } = createUpdater(session);

    await expect(repairPersistedRemoteSessionPaths(store, session)).rejects.toMatchObject({
      type: CoreErrorType.SessionCorrupted,
      context: { reason: REMOTE_SESSION_PATH_CORRUPTION_REASON, sessionId: session.id },
      recoverable: true,
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("reports malformed persisted remote identity as session corruption", async () => {
    const session = createSession({
      workspaceID: "remote:wsl:Debian" as WorkspaceId,
      directory: "/home/dev/project",
    });
    const { store, updateSession } = createUpdater(session);

    await expect(repairPersistedRemoteSessionPaths(store, session)).rejects.toMatchObject({
      type: CoreErrorType.SessionCorrupted,
      context: { reason: REMOTE_SESSION_PATH_CORRUPTION_REASON, sessionId: session.id },
      recoverable: true,
    });
    expect(updateSession).not.toHaveBeenCalled();
  });
});
