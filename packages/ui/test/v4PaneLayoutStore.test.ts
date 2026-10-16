// 分屏二期：Layout/Focus 两层状态机单测（分割树纯转移函数 + zustand store + 持久化/迁移）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SPLIT_RATIO,
  INITIAL_PANE_LAYOUT,
  MAX_WORKBENCH_PANES,
  PANE_LAYOUT_STORAGE_KEY,
  PANE_LAYOUT_STORAGE_KEY_V1,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  V4_LEGACY_SPLIT_PANE_ID,
  V4_PRIMARY_PANE_ID,
  bindPaneSession,
  canAddPane,
  clampSplitRatio,
  closePane,
  confirmRestoredPaneSession,
  countPanes,
  effectiveFocusedPaneId,
  focusPane,
  leafPaneIds,
  migratePersistedPaneLayoutV1,
  openSessionInNewPane,
  paneWorkspaceKey,
  persistPaneLayout,
  readPersistedPaneLayout,
  sanitizePersistedPaneLayout,
  setSplitNodeRatio,
  splitPaneAt,
  splitPaneAtSide,
  usePaneLayoutStore,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";

const SCOPE_A: PaneWorkspaceScope = { workspacePath: "/ws/a" };
const SCOPE_B: PaneWorkspaceScope = {
  workspacePath: "/mnt/b",
  workspaceIdentity: "ssh://host/mnt/b",
  remoteSessionId: "remote-1",
};

function draft(scope: PaneWorkspaceScope): PaneBinding {
  return { workspaceScope: scope, sessionId: null };
}

function bound(scope: PaneWorkspaceScope, sessionId: string): PaneBinding {
  return { workspaceScope: scope, sessionId };
}

describe("paneWorkspaceKey（身份/隔离口径）", () => {
  it("identity 优先（trim 后非空），否则回落 workspacePath", () => {
    expect(paneWorkspaceKey(SCOPE_A)).toBe("/ws/a");
    expect(paneWorkspaceKey(SCOPE_B)).toBe("ssh://host/mnt/b");
    expect(
      paneWorkspaceKey({ workspacePath: "/x", workspaceIdentity: "  " }),
    ).toBe("/x");
  });
});

describe("分割树纯状态机", () => {
  it("初始态：单 primary 叶子，焦点在 primary", () => {
    expect(INITIAL_PANE_LAYOUT.root).toEqual({
      type: "leaf",
      paneId: V4_PRIMARY_PANE_ID,
    });
    expect(INITIAL_PANE_LAYOUT.panes).toEqual({});
    expect(INITIAL_PANE_LAYOUT.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);
    expect(countPanes(INITIAL_PANE_LAYOUT)).toBe(1);
  });

  it("splitPaneAt：primary 向右拆分 → 双叶子行分割，新 pane 接管焦点", () => {
    const next = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    expect(leafPaneIds(next.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(next.root.type).toBe("split");
    if (next.root.type === "split") {
      expect(next.root.direction).toBe("row");
      expect(next.root.ratio).toBe(DEFAULT_SPLIT_RATIO);
    }
    expect(next.panes["pane-1"]).toEqual(draft(SCOPE_A));
    expect(next.focusedPaneId).toBe("pane-1");
  });

  it("splitPaneAt：嵌套拆分覆盖 2x2 网格；pane id 单调分配不复用", () => {
    let state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    state = splitPaneAt(state, V4_PRIMARY_PANE_ID, "column", draft(SCOPE_A));
    state = splitPaneAt(state, "pane-1", "column", bound(SCOPE_B, "sess-b"));
    expect(leafPaneIds(state.root)).toEqual([
      V4_PRIMARY_PANE_ID,
      "pane-2",
      "pane-1",
      "pane-3",
    ]);
    expect(countPanes(state)).toBe(4);
    expect(canAddPane(state)).toBe(false);
    // 关掉一个再拆，id 继续向前（pane-2 关闭后新 pane 是 pane-4，不复用）
    state = closePane(state, "pane-2");
    state = splitPaneAt(state, "pane-3", "row", draft(SCOPE_A));
    expect(leafPaneIds(state.root)).toContain("pane-4");
    expect(leafPaneIds(state.root)).not.toContain("pane-2");
  });

  it("splitPaneAt：anchor 不在树中 / 叶子数达上限 → no-op 原引用", () => {
    expect(
      splitPaneAt(INITIAL_PANE_LAYOUT, "nope", "row", draft(SCOPE_A)),
    ).toBe(INITIAL_PANE_LAYOUT);
    let state = INITIAL_PANE_LAYOUT;
    for (let i = 0; i < MAX_WORKBENCH_PANES - 1; i++) {
      state = splitPaneAt(state, V4_PRIMARY_PANE_ID, "row", draft(SCOPE_A));
    }
    expect(countPanes(state)).toBe(MAX_WORKBENCH_PANES);
    expect(splitPaneAt(state, V4_PRIMARY_PANE_ID, "row", draft(SCOPE_A))).toBe(
      state,
    );
  });

  it("splitPaneAtSide：left/up 把新 pane 放在 anchor 前，right/down 放在 anchor 后", () => {
    let state = splitPaneAtSide(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "left",
      bound(SCOPE_A, "sess-left"),
    );
    expect(leafPaneIds(state.root)).toEqual(["pane-1", V4_PRIMARY_PANE_ID]);
    expect(state.root.type === "split" && state.root.direction).toBe("row");
    expect(state.panes["pane-1"]).toEqual(bound(SCOPE_A, "sess-left"));

    state = splitPaneAtSide(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "up",
      bound(SCOPE_A, "sess-up"),
    );
    expect(leafPaneIds(state.root)).toEqual(["pane-1", V4_PRIMARY_PANE_ID]);
    expect(state.root.type === "split" && state.root.direction).toBe("column");

    state = splitPaneAtSide(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "right",
      bound(SCOPE_A, "sess-right"),
    );
    expect(leafPaneIds(state.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(state.root.type === "split" && state.root.direction).toBe("row");

    state = splitPaneAtSide(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "down",
      bound(SCOPE_A, "sess-down"),
    );
    expect(leafPaneIds(state.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(state.root.type === "split" && state.root.direction).toBe("column");
  });

  it("splitPaneAtSide：未知 anchor 或达到上限时 no-op", () => {
    expect(
      splitPaneAtSide(
        INITIAL_PANE_LAYOUT,
        "missing",
        "right",
        bound(SCOPE_A, "x"),
      ),
    ).toBe(INITIAL_PANE_LAYOUT);

    let state = INITIAL_PANE_LAYOUT;
    for (let i = 0; i < MAX_WORKBENCH_PANES - 1; i++) {
      state = splitPaneAtSide(
        state,
        V4_PRIMARY_PANE_ID,
        "right",
        bound(SCOPE_A, `sess-${i}`),
      );
    }
    expect(countPanes(state)).toBe(MAX_WORKBENCH_PANES);
    expect(
      splitPaneAtSide(
        state,
        V4_PRIMARY_PANE_ID,
        "right",
        bound(SCOPE_A, "overflow"),
      ),
    ).toBe(state);
  });

  it("closePane：父分割节点塌缩为兄弟子树；焦点在被关 pane 上时归还 primary", () => {
    let state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      bound(SCOPE_A, "sess-1"),
    );
    state = splitPaneAt(state, "pane-1", "column", draft(SCOPE_B));
    expect(state.focusedPaneId).toBe("pane-2");
    const closed = closePane(state, "pane-2");
    expect(leafPaneIds(closed.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(closed.panes["pane-2"]).toBeUndefined();
    expect(closed.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);
    // 全关回单 pane
    const single = closePane(closed, "pane-1");
    expect(single.root).toEqual({ type: "leaf", paneId: V4_PRIMARY_PANE_ID });
    expect(single.panes).toEqual({});
  });

  it("closePane：primary 不可关 / 未知 pane → no-op 原引用；焦点在别处时保留", () => {
    expect(closePane(INITIAL_PANE_LAYOUT, V4_PRIMARY_PANE_ID)).toBe(
      INITIAL_PANE_LAYOUT,
    );
    expect(closePane(INITIAL_PANE_LAYOUT, "nope")).toBe(INITIAL_PANE_LAYOUT);
    let state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    state = splitPaneAt(state, "pane-1", "row", draft(SCOPE_A));
    state = focusPane(state, "pane-1");
    const closed = closePane(state, "pane-2");
    expect(closed.focusedPaneId).toBe("pane-1");
  });

  it("focusPane：只接受树中存在的叶子；重复聚焦/未知 pane 返回原引用", () => {
    const opened = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    const primaryFocused = focusPane(opened, V4_PRIMARY_PANE_ID);
    expect(primaryFocused.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);
    expect(primaryFocused.panes).toBe(opened.panes);
    expect(focusPane(primaryFocused, V4_PRIMARY_PANE_ID)).toBe(primaryFocused);
    expect(focusPane(primaryFocused, "nope")).toBe(primaryFocused);
  });

  it("effectiveFocusedPaneId：焦点 pane 不在树中时退化为 primary", () => {
    const opened = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    expect(effectiveFocusedPaneId(opened)).toBe("pane-1");
    const corrupted: PaneLayoutSnapshot = { ...opened, focusedPaneId: "gone" };
    expect(effectiveFocusedPaneId(corrupted)).toBe(V4_PRIMARY_PANE_ID);
  });

  it("bindPaneSession：draft 首发后原地绑定并清待验证标记；无绑定/未变时 no-op", () => {
    const opened = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    const boundState = bindPaneSession(opened, "pane-1", "sess-new");
    expect(boundState.panes["pane-1"]).toEqual(bound(SCOPE_A, "sess-new"));
    expect(bindPaneSession(boundState, "pane-1", "sess-new")).toBe(boundState);
    expect(bindPaneSession(INITIAL_PANE_LAYOUT, "pane-1", "x")).toBe(
      INITIAL_PANE_LAYOUT,
    );
    // 实时重绑即权威：清掉 restoredUnvalidated
    const restored: PaneLayoutSnapshot = {
      ...opened,
      panes: {
        "pane-1": {
          workspaceScope: SCOPE_A,
          sessionId: "sess-old",
          restoredUnvalidated: true,
        },
      },
    };
    const rebound = bindPaneSession(restored, "pane-1", "sess-old");
    expect(rebound.panes["pane-1"]?.restoredUnvalidated).toBeUndefined();
  });

  it("setSplitNodeRatio：按节点 id 定位并 clamp；未知节点/未变化返回原引用", () => {
    const opened = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    const splitId = opened.root.type === "split" ? opened.root.id : "";
    const widened = setSplitNodeRatio(opened, splitId, 0.9);
    expect(widened.root.type === "split" && widened.root.ratio).toBe(
      SPLIT_RATIO_MAX,
    );
    expect(setSplitNodeRatio(opened, splitId, 0.1).root).toMatchObject({
      ratio: SPLIT_RATIO_MIN,
    });
    expect(setSplitNodeRatio(opened, "nope", 0.6)).toBe(opened);
    expect(setSplitNodeRatio(opened, splitId, DEFAULT_SPLIT_RATIO)).toBe(
      opened,
    );
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_SPLIT_RATIO,
    );
    // 嵌套：只改目标节点，其余子树原引用
    const nested = splitPaneAt(widened, "pane-1", "column", draft(SCOPE_B));
    const innerId =
      nested.root.type === "split" && nested.root.second.type === "split"
        ? nested.root.second.id
        : "";
    const innerChanged = setSplitNodeRatio(nested, innerId, 0.7);
    expect(
      innerChanged.root.type === "split" && innerChanged.root.first,
    ).toBe(nested.root.type === "split" && nested.root.first);
  });

  it("confirmRestoredPaneSession：验证在场清标记；无标记 no-op 原引用", () => {
    const restored: PaneLayoutSnapshot = {
      root: {
        type: "split",
        id: "n1",
        direction: "row",
        ratio: 0.5,
        first: { type: "leaf", paneId: V4_PRIMARY_PANE_ID },
        second: { type: "leaf", paneId: "pane-1" },
      },
      panes: {
        "pane-1": {
          workspaceScope: SCOPE_A,
          sessionId: "sess-b",
          restoredUnvalidated: true,
        },
      },
      focusedPaneId: "pane-1",
    };
    const confirmed = confirmRestoredPaneSession(restored, "pane-1");
    expect(confirmed.panes["pane-1"]).toEqual(bound(SCOPE_A, "sess-b"));
    expect(confirmRestoredPaneSession(confirmed, "pane-1")).toBe(confirmed);
    expect(confirmRestoredPaneSession(INITIAL_PANE_LAYOUT, "pane-1")).toBe(
      INITIAL_PANE_LAYOUT,
    );
  });

  it("openSessionInNewPane：新 session 拆分焦点 pane；已开（同 workspaceKey+session）→ 聚焦", () => {
    const opened = openSessionInNewPane(INITIAL_PANE_LAYOUT, SCOPE_A, "sess-1");
    expect(opened.panes["pane-1"]).toEqual(bound(SCOPE_A, "sess-1"));
    expect(opened.focusedPaneId).toBe("pane-1");
    // 再开另一 session：拆分当前焦点（pane-1）
    const two = openSessionInNewPane(opened, SCOPE_B, "sess-2");
    expect(two.panes["pane-2"]).toEqual(bound(SCOPE_B, "sess-2"));
    // 已开的 session：聚焦既有 pane，不新增
    const focusedBack = focusPane(two, V4_PRIMARY_PANE_ID);
    const refocus = openSessionInNewPane(focusedBack, SCOPE_A, "sess-1");
    expect(countPanes(refocus)).toBe(3);
    expect(refocus.focusedPaneId).toBe("pane-1");
  });

  it("openSessionInNewPane：达上限且非既有 session → no-op", () => {
    let state = INITIAL_PANE_LAYOUT;
    for (let i = 0; i < MAX_WORKBENCH_PANES - 1; i++) {
      state = openSessionInNewPane(state, SCOPE_A, `sess-${i}`);
    }
    expect(canAddPane(state)).toBe(false);
    expect(openSessionInNewPane(state, SCOPE_A, "sess-max")).toBe(state);
    // 既有 session 仍可聚焦
    const refocus = openSessionInNewPane(state, SCOPE_A, "sess-0");
    expect(refocus.focusedPaneId).toBe("pane-1");
  });
});

describe("持久化（localStorage v2 + v1 迁移）", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("persist → read 闭环：树 + 绑定（含远程 scope）+ 焦点恢复，session 绑定带待验证标记", () => {
    let state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      bound(SCOPE_B, "sess-b"),
    );
    state = splitPaneAt(state, "pane-1", "column", draft(SCOPE_A));
    const splitId = state.root.type === "split" ? state.root.id : "";
    state = setSplitNodeRatio(state, splitId, 0.61);
    persistPaneLayout(state);

    const restored = readPersistedPaneLayout();
    expect(restored).not.toBeNull();
    expect(leafPaneIds(restored!.root)).toEqual(leafPaneIds(state.root));
    expect(restored!.root).toMatchObject({ ratio: 0.61 });
    expect(restored!.panes["pane-1"]).toEqual({
      workspaceScope: SCOPE_B,
      sessionId: "sess-b",
      restoredUnvalidated: true,
    });
    // draft pane 恢复不带待验证标记
    expect(restored!.panes["pane-2"]).toEqual(draft(SCOPE_A));
    expect(restored!.focusedPaneId).toBe("pane-2");
  });

  it("restoredUnvalidated 不进持久化面", () => {
    const state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      bound(SCOPE_A, "sess-x"),
    );
    persistPaneLayout(state);
    expect(store.get(PANE_LAYOUT_STORAGE_KEY)).not.toContain(
      "restoredUnvalidated",
    );
  });

  it("v1 迁移：本地路径 workspaceKey → 双叶子树（保留 split id 与 splitRatio）", () => {
    store.set(
      PANE_LAYOUT_STORAGE_KEY_V1,
      JSON.stringify({
        splitPane: { workspaceKey: "/ws/legacy", sessionId: "sess-old" },
        focusedPaneId: V4_LEGACY_SPLIT_PANE_ID,
        splitRatio: 0.7,
      }),
    );
    const restored = readPersistedPaneLayout();
    expect(restored).not.toBeNull();
    expect(leafPaneIds(restored!.root)).toEqual([
      V4_PRIMARY_PANE_ID,
      V4_LEGACY_SPLIT_PANE_ID,
    ]);
    expect(restored!.root).toMatchObject({ direction: "row", ratio: 0.7 });
    expect(restored!.panes[V4_LEGACY_SPLIT_PANE_ID]).toEqual({
      workspaceScope: { workspacePath: "/ws/legacy" },
      sessionId: "sess-old",
      restoredUnvalidated: true,
    });
    expect(restored!.focusedPaneId).toBe(V4_LEGACY_SPLIT_PANE_ID);
  });

  it("v1 迁移：workspaceKey 非本地路径（远程 identity）/ 无 splitPane → 丢弃回 null", () => {
    expect(
      migratePersistedPaneLayoutV1({
        splitPane: { workspaceKey: "ssh://host/x", sessionId: "s" },
        focusedPaneId: "split",
        splitRatio: 0.5,
      }),
    ).toBeNull();
    expect(migratePersistedPaneLayoutV1({ splitPane: null })).toBeNull();
    // Windows 盘符路径可迁移
    expect(
      migratePersistedPaneLayoutV1({
        splitPane: { workspaceKey: "C:\\ws\\a", sessionId: null },
      }),
    ).not.toBeNull();
  });

  it("v2 优先于 v1：两个 key 并存时读 v2", () => {
    const state = splitPaneAt(
      INITIAL_PANE_LAYOUT,
      V4_PRIMARY_PANE_ID,
      "row",
      draft(SCOPE_A),
    );
    persistPaneLayout(state);
    store.set(
      PANE_LAYOUT_STORAGE_KEY_V1,
      JSON.stringify({
        splitPane: { workspaceKey: "/ws/legacy", sessionId: "sess-old" },
      }),
    );
    const restored = readPersistedPaneLayout();
    expect(restored!.panes["pane-1"]).toEqual(draft(SCOPE_A));
  });

  it("降级：无记录/损坏 JSON/非对象 → null（回初始布局）；无 storage 环境读写均静默", () => {
    expect(readPersistedPaneLayout()).toBeNull();
    store.set(PANE_LAYOUT_STORAGE_KEY, "{not json");
    expect(readPersistedPaneLayout()).toBeNull();
    store.set(PANE_LAYOUT_STORAGE_KEY, JSON.stringify("a string"));
    expect(readPersistedPaneLayout()).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => persistPaneLayout(INITIAL_PANE_LAYOUT)).not.toThrow();
    expect(readPersistedPaneLayout()).toBeNull();
  });
});

describe("sanitizePersistedPaneLayout（损坏数据整体丢弃）", () => {
  const validTree = {
    type: "split",
    id: "n1",
    direction: "row",
    ratio: 0.5,
    first: { type: "leaf", paneId: V4_PRIMARY_PANE_ID },
    second: { type: "leaf", paneId: "pane-1" },
  };
  const validBinding = {
    workspaceScope: { workspacePath: "/ws/a" },
    sessionId: null,
  };

  it("合法载荷通过；ratio 越界 clamp；focusedPaneId 不在树中回 primary", () => {
    const restored = sanitizePersistedPaneLayout({
      root: { ...validTree, ratio: 0.99 },
      panes: { "pane-1": validBinding },
      focusedPaneId: "gone",
    });
    expect(restored).not.toBeNull();
    expect(restored!.root).toMatchObject({ ratio: SPLIT_RATIO_MAX });
    expect(restored!.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);
  });

  it("整体丢弃：树损坏 / 缺 primary / 叶子 id 重复 / 超上限 / 非 primary 叶子缺绑定", () => {
    expect(sanitizePersistedPaneLayout(null)).toBeNull();
    expect(
      sanitizePersistedPaneLayout({ root: { type: "leaf" }, panes: {} }),
    ).toBeNull();
    // 缺 primary
    expect(
      sanitizePersistedPaneLayout({
        root: { type: "leaf", paneId: "pane-1" },
        panes: { "pane-1": validBinding },
      }),
    ).toBeNull();
    // 叶子 id 重复
    expect(
      sanitizePersistedPaneLayout({
        root: {
          ...validTree,
          second: { type: "leaf", paneId: V4_PRIMARY_PANE_ID },
        },
        panes: {},
      }),
    ).toBeNull();
    // 非 primary 叶子缺绑定 / scope 缺 workspacePath
    expect(
      sanitizePersistedPaneLayout({ root: validTree, panes: {} }),
    ).toBeNull();
    expect(
      sanitizePersistedPaneLayout({
        root: validTree,
        panes: { "pane-1": { workspaceScope: {}, sessionId: null } },
      }),
    ).toBeNull();
  });

  it("sessionId 非字符串归 null（不带待验证标记）", () => {
    const restored = sanitizePersistedPaneLayout({
      root: validTree,
      panes: {
        "pane-1": { workspaceScope: { workspacePath: "/ws/a" }, sessionId: 42 },
      },
      focusedPaneId: "pane-1",
    });
    expect(restored!.panes["pane-1"]?.sessionId).toBeNull();
    expect(restored!.panes["pane-1"]?.restoredUnvalidated).toBeUndefined();
  });
});

describe("usePaneLayoutStore（zustand 装配）", () => {
  it("action 驱动状态转移且 action 引用稳定", () => {
    const before = usePaneLayoutStore.getState();
    before.splitPane(V4_PRIMARY_PANE_ID, "row", SCOPE_A);
    let state = usePaneLayoutStore.getState();
    const newPaneId = leafPaneIds(state.root).find(
      (paneId) => paneId !== V4_PRIMARY_PANE_ID,
    )!;
    expect(state.panes[newPaneId]?.workspaceScope).toEqual(SCOPE_A);
    expect(state.focusedPaneId).toBe(newPaneId);

    state.bindPaneSession(newPaneId, "sess-1");
    state.focusPane(V4_PRIMARY_PANE_ID);
    state = usePaneLayoutStore.getState();
    expect(state.panes[newPaneId]?.sessionId).toBe("sess-1");
    expect(state.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);

    const splitId = state.root.type === "split" ? state.root.id : "";
    state.setSplitRatio(splitId, 0.66);
    state = usePaneLayoutStore.getState();
    expect(state.root).toMatchObject({ ratio: 0.66 });

    state.openSessionInNewPane(SCOPE_B, "sess-2");
    state = usePaneLayoutStore.getState();
    expect(countPanes(state)).toBe(3);

    state.closePane(state.focusedPaneId);
    state.closePane(newPaneId);
    state = usePaneLayoutStore.getState();
    expect(state.root).toEqual({ type: "leaf", paneId: V4_PRIMARY_PANE_ID });
    expect(state.focusedPaneId).toBe(V4_PRIMARY_PANE_ID);

    expect(state.splitPane).toBe(before.splitPane);
    expect(state.openSessionInNewPane).toBe(before.openSessionInNewPane);
    expect(state.closePane).toBe(before.closePane);
    expect(state.focusPane).toBe(before.focusPane);
    expect(state.bindPaneSession).toBe(before.bindPaneSession);
    expect(state.setSplitRatio).toBe(before.setSplitRatio);
    expect(state.confirmRestoredPaneSession).toBe(
      before.confirmRestoredPaneSession,
    );
  });
});
