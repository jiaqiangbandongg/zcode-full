import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_WORKBENCH_GROUP_STATE,
  WORKBENCH_GROUP_STORAGE_KEY,
  buildWorkbenchSessionKey,
  closeWorkbenchGroupPane,
  confirmRestoredWorkbenchGroupPane,
  createWorkbenchGroupFromSessions,
  focusWorkbenchGroupPane,
  persistWorkbenchGroups,
  readPersistedWorkbenchGroups,
  selectWorkbenchGroupActiveBinding,
  splitWorkbenchGroupPane,
  useWorkbenchGroupStore,
  type WorkbenchGroupSnapshot,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";
import {
  MAX_WORKBENCH_PANES,
  V4_PRIMARY_PANE_ID,
  countPanes,
  leafPaneIds,
} from "@/v4/paneLayoutStore.js";

const SCOPE_A = { workspacePath: "/ws/a" };
const SCOPE_B = {
  workspacePath: "/mnt/b",
  workspaceIdentity: " remote:ssh:host:/mnt/b ",
  remoteSessionId: "remote-1",
};
const SCOPE_C = { workspacePath: "/ws/c" };

function binding(
  scope: WorkbenchSessionBinding["workspaceScope"],
  sessionId: string,
): WorkbenchSessionBinding {
  return { workspaceScope: scope, sessionId };
}

describe("workbench group pure model", () => {
  it("creates a group by splitting an ungrouped session around the active single session", () => {
    const group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "left",
      { id: "group-test", updatedAt: 1 },
    );

    expect(group.id).toBe("group-test");
    expect(group.primaryBinding).toEqual(binding(SCOPE_A, "sess-a"));
    expect(leafPaneIds(group.root)).toEqual(["pane-1", V4_PRIMARY_PANE_ID]);
    expect(group.panes["pane-1"]).toEqual(binding(SCOPE_B, "sess-b"));
    expect(group.focusedPaneId).toBe("pane-1");
  });

  it("clicking a grouped session activates its group and focused pane", () => {
    const group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "right",
      { id: "group-test", updatedAt: 1 },
    );

    const focused = focusWorkbenchGroupPane(group, V4_PRIMARY_PANE_ID);
    expect(focused.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);
    expect(selectWorkbenchGroupActiveBinding(focused)).toEqual(binding(SCOPE_A, "sess-a"));
    expect(selectWorkbenchGroupActiveBinding(group)).toEqual(binding(SCOPE_B, "sess-b"));
  });

  it("rejects duplicate session membership and 4-pane overflow", () => {
    let group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "right",
      { id: "group-test", updatedAt: 1 },
    );

    expect(
      splitWorkbenchGroupPane(group, V4_PRIMARY_PANE_ID, "right", binding(SCOPE_B, "sess-b"), 2),
    ).toBe(group);

    group = splitWorkbenchGroupPane(
      group,
      V4_PRIMARY_PANE_ID,
      "right",
      binding(SCOPE_C, "sess-c"),
      2,
    );
    group = splitWorkbenchGroupPane(group, "pane-2", "down", binding(SCOPE_A, "sess-d"), 3);
    expect(countPanes(group)).toBe(MAX_WORKBENCH_PANES);
    expect(
      splitWorkbenchGroupPane(group, "pane-3", "right", binding(SCOPE_A, "sess-overflow"), 4),
    ).toBe(group);
  });

  it("garbage collects a group when closing leaves one session", () => {
    const group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "right",
      { id: "group-test", updatedAt: 1 },
    );

    expect(closeWorkbenchGroupPane(group, "pane-1", 2)).toBeNull();
  });
});

describe("workbench group store and persistence", () => {
  const storage = new Map<string, string>();
  let storageReadCount = 0;
  let storageWriteCount = 0;

  beforeEach(() => {
    storage.clear();
    storageReadCount = 0;
    storageWriteCount = 0;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => {
        storageReadCount += 1;
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        storageWriteCount += 1;
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    };
    useWorkbenchGroupStore.getState().configureClientMode("desktop-continuous");
    useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  });

  afterEach(() => {
    useWorkbenchGroupStore.getState().configureClientMode("desktop-continuous");
    useWorkbenchGroupStore.getState().resetWorkbenchGroups();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("opens grouped sessions from sidebar and clears group for ungrouped sessions", () => {
    const store = useWorkbenchGroupStore.getState();
    store.splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      binding(SCOPE_B, "sess-b"),
      binding(SCOPE_A, "sess-a"),
    );

    const groupId = useWorkbenchGroupStore.getState().activeGroupId;
    expect(groupId).toBeTruthy();

    useWorkbenchGroupStore.getState().openSessionFromSidebar(binding(SCOPE_A, "sess-a"));
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBe(groupId);
    expect(useWorkbenchGroupStore.getState().getActiveContext()).toEqual(
      binding(SCOPE_A, "sess-a"),
    );

    useWorkbenchGroupStore.getState().openSessionFromSidebar(binding(SCOPE_C, "sess-c"));
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });

  it("does not restore, consume, create, or persist groups in web remote mode", () => {
    const store = useWorkbenchGroupStore.getState();
    const persistedGroup = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "right",
      { id: "persisted-group", updatedAt: 1 },
    );
    persistWorkbenchGroups({
      activeGroupId: persistedGroup.id,
      groups: { [persistedGroup.id]: persistedGroup },
      sessionIndex: {
        [buildWorkbenchSessionKey(SCOPE_A, "sess-a")]: persistedGroup.id,
        [buildWorkbenchSessionKey(SCOPE_B, "sess-b")]: persistedGroup.id,
      },
    });
    const persistedBeforeRemote = storage.get(WORKBENCH_GROUP_STORAGE_KEY);
    const readsBeforeRemote = storageReadCount;
    const writesBeforeRemote = storageWriteCount;

    store.configureClientMode("web-remote-replayable");
    const remoteStore = useWorkbenchGroupStore.getState();

    expect(remoteStore.activeGroupId).toBeNull();
    expect(remoteStore.groups).toEqual({});
    expect(readPersistedWorkbenchGroups()).toBeNull();
    remoteStore.openSessionFromSidebar(binding(SCOPE_A, "sess-a"));
    remoteStore.splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      binding(SCOPE_B, "sess-b"),
      binding(SCOPE_A, "sess-a"),
    );
    expect(useWorkbenchGroupStore.getState().groups).toEqual({});
    expect(storage.get(WORKBENCH_GROUP_STORAGE_KEY)).toBe(persistedBeforeRemote);
    expect(storageReadCount).toBe(readsBeforeRemote);
    expect(storageWriteCount).toBe(writesBeforeRemote);

    remoteStore.configureClientMode("desktop-continuous");
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBe(persistedGroup.id);
    expect(useWorkbenchGroupStore.getState().getActiveContext()).toEqual(
      expect.objectContaining({
        workspaceScope: SCOPE_B,
        sessionId: "sess-b",
      }),
    );
  });

  it("updates and persists the active group ratio without rebuilding workspace bindings", () => {
    useWorkbenchGroupStore.getState().splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      binding(SCOPE_B, "sess-b"),
      binding(SCOPE_A, "sess-a"),
    );
    const before = useWorkbenchGroupStore.getState();
    const groupId = before.activeGroupId!;
    const splitId = before.groups[groupId]!.root.type === "split"
      ? before.groups[groupId]!.root.id
      : "missing";
    const store = before as typeof before & {
      setSplitRatio: (groupId: string, splitId: string, ratio: number) => void;
    };

    expect(typeof store.setSplitRatio).toBe("function");
    store.setSplitRatio(groupId, splitId, 0.65);

    const after = useWorkbenchGroupStore.getState();
    expect(after.groups[groupId]?.root).toMatchObject({ type: "split", ratio: 0.65 });
    expect(after.groups[groupId]?.primaryBinding).toEqual(binding(SCOPE_A, "sess-a"));
    expect(after.groups[groupId]?.panes["pane-1"]).toEqual(binding(SCOPE_B, "sess-b"));
    expect(after.sessionIndex).toEqual({
      [buildWorkbenchSessionKey(SCOPE_A, "sess-a")]: groupId,
      [buildWorkbenchSessionKey(SCOPE_B, "sess-b")]: groupId,
    });
    expect(readPersistedWorkbenchGroups()?.groups[groupId]?.root).toMatchObject({
      type: "split",
      ratio: 0.65,
    });
  });

  it("persists and restores localStorage state with workspaceIdentity keys", () => {
    const group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      binding(SCOPE_B, "sess-b"),
      "right",
      { id: "group-test", updatedAt: 1 },
    );
    const snapshot: WorkbenchGroupSnapshot = {
      ...INITIAL_WORKBENCH_GROUP_STATE,
      activeGroupId: group.id,
      groups: { [group.id]: group },
      sessionIndex: {
        [buildWorkbenchSessionKey(SCOPE_A, "sess-a")]: group.id,
        [buildWorkbenchSessionKey(SCOPE_B, "sess-b")]: group.id,
      },
    };

    persistWorkbenchGroups(snapshot);
    expect(storage.get(WORKBENCH_GROUP_STORAGE_KEY)).toContain("remote:ssh:host:/mnt/b::sess-b");

    const restored = readPersistedWorkbenchGroups();
    expect(restored?.activeGroupId).toBe(group.id);
    expect(restored?.sessionIndex).toEqual(snapshot.sessionIndex);
    expect(restored?.groups[group.id]?.panes["pane-1"]).toEqual({
      ...binding(SCOPE_B, "sess-b"),
      restoredUnvalidated: true,
    });
    persistWorkbenchGroups(restored as WorkbenchGroupSnapshot);
    expect(storage.get(WORKBENCH_GROUP_STORAGE_KEY)).not.toContain(
      "restoredUnvalidated",
    );
    expect(
      confirmRestoredWorkbenchGroupPane(
        restored?.groups[group.id] as NonNullable<typeof restored>["groups"][string],
        "pane-1",
      ).panes["pane-1"],
    ).toEqual(binding(SCOPE_B, "sess-b"));
  });

  it("drops persisted legacy read-only subagent groups during restore", () => {
    const group = createWorkbenchGroupFromSessions(
      binding(SCOPE_A, "sess-a"),
      { ...binding(SCOPE_B, "sess-b"), readOnly: true },
      "right",
      { id: "legacy-subagent-group", updatedAt: 1 },
    );
    persistWorkbenchGroups({
      ...INITIAL_WORKBENCH_GROUP_STATE,
      activeGroupId: group.id,
      groups: { [group.id]: group },
      sessionIndex: {
        [buildWorkbenchSessionKey(SCOPE_A, "sess-a")]: group.id,
        [buildWorkbenchSessionKey(SCOPE_B, "sess-b")]: group.id,
      },
    });

    expect(readPersistedWorkbenchGroups()).toBeNull();
  });
});
