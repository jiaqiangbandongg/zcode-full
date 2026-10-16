import { ensureGroupTaskPermissionScope } from "../src/runtime/methods/input-intent-persistence.js";
import { describe, expect, it, vi } from "vitest";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "../src/tool/executor/permission-rules-persistence.js";

describe("group task permission isolation", () => {
  it("reads and writes session-scoped grants without inheriting workspace approval", async () => {
    const sessionStore = {
      getSession: vi.fn(async () => ({
        id: "s",
        projectID: "project",
        permission: { version: 1, scope: "session" },
      })),
      getProjectPermission: vi.fn(async () => ({ version: 1, allow: [{ toolName: "Bash" }] })),
      saveProjectPermission: vi.fn(),
      updateSession: vi.fn(async () => undefined),
    };
    const deps = { sessionId: "s", sessionStore } as never;
    expect(await loadProjectPermissionRuleset(deps)).toEqual({ version: 1, scope: "session" });
    await persistProjectPermissionUpdates(
      deps,
      [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }] }],
      {} as never,
    );
    expect(sessionStore.getProjectPermission).not.toHaveBeenCalled();
    expect(sessionStore.saveProjectPermission).not.toHaveBeenCalled();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s",
        permission: expect.objectContaining({ scope: "session", allow: [{ toolName: "Read" }] }),
      }),
    );
  });
  it("initializes a group task with approval and fails closed without persistence", async () => {
    const intent = { botGroupSource: { botId: "bot", chatId: "group" } } as never;
    await expect(ensureGroupTaskPermissionScope(undefined, "s", intent)).rejects.toThrow("persist");
    const session = { permission: { mode: "yolo", allow: [{ toolName: "Bash" }] } };
    const store = {
      getSession: vi.fn(async () => session),
      updateSession: vi.fn(async () => undefined),
    };
    await ensureGroupTaskPermissionScope(store as never, "s", intent);
    expect(store.updateSession).toHaveBeenCalledWith({
      id: "s",
      permission: { version: 1, scope: "session", mode: "build" },
    });
    store.getSession.mockResolvedValueOnce({
      permission: { version: 1, scope: "session", mode: "yolo" },
    } as never);
    await ensureGroupTaskPermissionScope(store as never, "s", intent);
    expect(store.updateSession).toHaveBeenCalledOnce();
  });
});
