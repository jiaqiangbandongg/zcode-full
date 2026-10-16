import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES,
  buildChatSessionScrollMemoryKey,
  clearChatSessionScrollMemoryForTest,
  migrateTaskScrollMemoryToSession,
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
} from "../src/lib/chatSessionScrollMemory.js";

describe("chat session scroll memory", () => {
  beforeEach(() => {
    clearChatSessionScrollMemoryForTest();
  });

  it("keys V4 scroll memory by workspace identity, pane, and session", () => {
    expect(
      buildChatSessionScrollMemoryKey({
        workspacePath: "/repo/demo",
        workspaceIdentity: "ssh://demo",
        paneId: "pane-1",
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ).toBe("ssh://demo::pane:pane-1::session:session-1");
  });

  it("keeps legacy keys compatible when pane id is absent", () => {
    expect(
      buildChatSessionScrollMemoryKey({
        workspacePath: "/repo/demo",
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ).toBe("/repo/demo::session:session-1");
  });

  it("isolates stored positions by workspace identity, pane, and session", () => {
    const scopes = [
      { workspaceIdentity: "ssh://one", paneId: "pane-1", sessionId: "session-1" },
      { workspaceIdentity: "ssh://one", paneId: "pane-2", sessionId: "session-1" },
      { workspaceIdentity: "ssh://one", paneId: "pane-1", sessionId: "session-2" },
      { workspaceIdentity: "ssh://two", paneId: "pane-1", sessionId: "session-1" },
    ];
    const keys = scopes.map((scope) =>
      buildChatSessionScrollMemoryKey({ workspacePath: "/same/path", ...scope }),
    );

    keys.forEach((key, index) => {
      saveChatSessionScrollMemoryState(key, {
        scrollTop: 100 + index,
        scrollHeight: 1000,
        clientHeight: 300,
        wasPinnedToBottom: false,
        updatedAt: index,
      });
    });

    expect(new Set(keys).size).toBe(scopes.length);
    expect(keys.map((key) => readChatSessionScrollMemoryState(key)?.scrollTop)).toEqual([
      100, 101, 102, 103,
    ]);
  });

  it("uses a task fallback until the ZCode Agent session id is restored", () => {
    expect(
      buildChatSessionScrollMemoryKey({
        workspacePath: "/repo/demo",
        sessionId: null,
        taskId: "task-1",
      }),
    ).toBe("/repo/demo::task:task-1");
  });

  it("migrates the temporary task bucket into the real session bucket", () => {
    const taskKey = buildChatSessionScrollMemoryKey({
      workspacePath: "/repo/demo",
      sessionId: null,
      taskId: "task-1",
    });
    saveChatSessionScrollMemoryState(taskKey, {
      scrollTop: 320,
      scrollHeight: 1000,
      clientHeight: 400,
      updatedAt: 1,
    });

    const sessionKey = migrateTaskScrollMemoryToSession({
      workspacePath: "/repo/demo",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(sessionKey).toBe("/repo/demo::session:session-1");
    expect(readChatSessionScrollMemoryState(taskKey)).toBeNull();
    expect(readChatSessionScrollMemoryState(sessionKey)?.scrollTop).toBe(320);
  });

  it("migrates task fallback memory inside the same pane", () => {
    const taskKey = buildChatSessionScrollMemoryKey({
      workspacePath: "/repo/demo",
      paneId: "pane-2",
      sessionId: null,
      taskId: "task-1",
    });
    saveChatSessionScrollMemoryState(taskKey, {
      scrollTop: 240,
      scrollHeight: 900,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });

    const sessionKey = migrateTaskScrollMemoryToSession({
      workspacePath: "/repo/demo",
      paneId: "pane-2",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(sessionKey).toBe("/repo/demo::pane:pane-2::session:session-1");
    expect(readChatSessionScrollMemoryState(taskKey)).toBeNull();
    expect(readChatSessionScrollMemoryState(sessionKey)?.scrollTop).toBe(240);
  });

  it("keeps bottom-lock intent when migrating scroll memory", () => {
    const taskKey = buildChatSessionScrollMemoryKey({
      workspacePath: "/repo/demo",
      sessionId: null,
      taskId: "task-1",
    });
    saveChatSessionScrollMemoryState(taskKey, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
      wasPinnedToBottom: true,
      updatedAt: 1,
    });

    const sessionKey = migrateTaskScrollMemoryToSession({
      workspacePath: "/repo/demo",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(readChatSessionScrollMemoryState(sessionKey)?.wasPinnedToBottom).toBe(true);
  });

  it("restores saved scroll positions and clamps them to the current range", () => {
    expect(
      resolveChatSessionScrollRestoreTop(
        {
          scrollTop: 50,
        },
        {
          scrollHeight: 1200,
          clientHeight: 300,
        },
      ),
    ).toBe(50);

    expect(
      resolveChatSessionScrollRestoreTop(
        {
          scrollTop: 1200,
        },
        {
          scrollHeight: 1000,
          clientHeight: 250,
        },
      ),
    ).toBe(750);
  });

  it("prunes old entries with an LRU cap", () => {
    for (let index = 0; index <= CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES; index += 1) {
      saveChatSessionScrollMemoryState(`workspace::session:${index}`, {
        scrollTop: index,
        scrollHeight: 1000,
        clientHeight: 300,
        updatedAt: index,
      });
    }

    expect(readChatSessionScrollMemoryState("workspace::session:0")).toBeNull();
    expect(
      readChatSessionScrollMemoryState(
        `workspace::session:${CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES}`,
      )?.scrollTop,
    ).toBe(CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES);
  });
});
