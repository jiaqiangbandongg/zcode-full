// @vitest-environment jsdom

// actor transcript 面板（docs/dynamic-workflow/presentation.md「Subagent transcripts」）：
// 嵌套只读 SessionPane，组合方式照 SubagentSessionSidePane。
//
// 这里钉的是**组合**，不是会话内容：actor 会话是真实持久会话，它的实时性、冷恢复与回看
// 全部由既有 SessionPane 链路负责。所以唯一需要保证的是「读到的是那个 actor 的会话，
// 而且是只读的」——把 sessionId 接错，面板会安静地显示另一个人的对话。
//
// 另一半是**未启动门**（「actor transcript 的未启动态」）：actor 会话在首个 ask 派发时才
// 创建，所以提前点开 tab 会订阅一条还不存在的会话，投影 store 随即停在 error 只等手动
// retry。门在 notStarted 时不挂订阅，改渲染占位。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";

const paneState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  /**
   * SessionPane **每次渲染**时的 sessionId（不是每次挂载——同一次挂载重渲染会重复入列）。
   * 因此空数组才是可断言的强命题；判身份时看去重集合，别把重渲染次数写进期望。
   */
  rendered: [] as string[],
}));

// layer 必须是**稳定引用**：门在渲染期同步 acquire 父会话租约（以 layer 为 useMemo 依赖），
// 每次渲染换一个新对象就会每帧建一份新租约。生产里 useV4Conversation 返回的是 useMemo 过的
// bundle，本来就稳定。
const leaseState = vi.hoisted(() => ({
  /** 经由 layer 订阅过的 sessionId 序列——门的断言面就是这一条。 */
  acquired: [] as string[],
  release: vi.fn(),
}));
const conversation = vi.hoisted(() => ({
  layer: {
    acquire: (sessionId: string) => {
      leaseState.acquired.push(sessionId);
      return { release: leaseState.release };
    },
  },
}));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      paneState.rendered.push(String(props.sessionId));
      // 复刻真 SessionPane 的订阅接缝（`SessionPane.tsx:1617-1633`：挂载 effect 里
      // `layer.acquire(effectiveSessionId)`，而 acquire 立刻 connect）。桩必须真的走一遍，
      // 否则「从没订阅过 actor 会话」会退化成一句空断言——桩本来就不订阅任何东西。
      React.useEffect(() => {
        const lease = conversation.layer.acquire(String(props.sessionId));
        return () => lease.release();
      }, [props.sessionId]);
      return React.createElement("div", { "data-testid": "mock-session-pane" });
    },
  };
});

const scopeState = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children, scope }: { children?: ReactNode; scope: unknown }) => {
      scopeState.scope = scope;
      return React.createElement(React.Fragment, null, children);
    },
    useV4Conversation: () => conversation,
  };
});

const projectionState = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock("@/v4/useConversationProjection.js", () => ({
  // 复刻生产语义：**租约为 null 时没有 snapshot**（`CLOSED_STATE`）。这一条不能图省事，
  // 否则门看起来在首帧就有投影，而生产里它还没有——SessionPane 会先挂一次、订阅失败，
  // 而失败的 store 会在 SessionDataLayer 的 keep-warm 里带着 status:"error" 活满 30s，
  // 门放行时的 acquire 直接复用它（refCount++ 不再 connect），死面板照旧。
  useConversationProjection: (lease: unknown) =>
    lease === null || lease === undefined
      ? { snapshot: undefined }
      : { snapshot: projectionState.snapshot },
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import/first
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
// eslint-disable-next-line import/first
import { openWorkflowActorSessionSidePane } from "@/lib/workspaceSidePane.js";

const ACTOR_SESSION_ID = "dwf-dwfrun-1-actor_1@2";

function tabOf(overrides: Partial<WorkflowActorSessionSidePaneTab> = {}) {
  const state = openWorkflowActorSessionSidePane(null, {
    workspaceKey: "ssh://host/workspace",
    workspacePath: "/workspace",
    workspaceIdentity: "ssh://host/workspace",
    remoteSessionId: "remote-1",
    parentSessionId: "parent-a",
    runId: "dwfrun-1",
    actorSessionId: ACTOR_SESSION_ID,
    siteId: "actor#1",
    ordinal: 2,
    actorName: "reviewer",
  });
  const tab = state.tabs[0] as WorkflowActorSessionSidePaneTab;
  return { ...tab, ...overrides };
}

/**
 * 该 actor 的 run 投影。`nodes` 决定门的判定；门按槽位 (runId, siteId, ordinal) 查 actor，
 * `actors` 可整体换掉（`[]` = 这个槽位还没出现）。
 */
function snapshotWith(
  nodes: WorkflowRunState["nodes"],
  sessionId = ACTOR_SESSION_ID,
  actors: WorkflowRunState["actors"] = [
    { siteId: "actor#1", ordinal: 2, name: "reviewer", sessionId, status: "waiting" },
  ],
) {
  return {
    rows: { window: [] },
    workflowRuns: {
      revision: 1,
      runs: [
        {
          runId: "dwfrun-1",
          status: "running" as const,
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors,
          nodes,
          lastEventSequence: 1,
        },
      ],
    },
  };
}

function renderTab(tab: WorkflowActorSessionSidePaneTab, locale: "en-US" | "zh-CN" = "en-US") {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(WorkflowActorSessionSidePane, { tab, focused: true }),
  );
}

function renderPane(locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
    ),
  );
}

describe("WorkflowActorSessionSidePane", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
    paneState.rendered = [];
    scopeState.scope = null;
    projectionState.snapshot = null;
    leaseState.acquired = [];
    leaseState.release.mockClear();
  });

  it("把 actor 会话喂给一个只读的嵌套 SessionPane", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
    );

    expect(paneState.props).toMatchObject({
      allowWorkspaceFileRewind: true,
      focused: true,
      paneId: tabOf().id,
      readOnly: true,
      // 关键一行：读的是 actor 会话，不是父会话，也不是 run id。
      sessionId: "dwf-dwfrun-1-actor_1@2",
      telemetryVisible: true,
      workspacePath: "/workspace",
    });
  });

  it("不下发 subagent 下钻回调：actor 的工具面里没有 subagent", () => {
    // 引擎 spec 的「Actor tool surface」把 subagent 关掉了，所以这里既没有嵌套下钻可点，
    // 也就不该假装有一个入口。
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(paneState.props?.onOpenSubagentSession).toBeUndefined();
    // rootSessionId 同理：actor 会话不在任何 subagent 树里，编一个根会让只读面板
    // 去订阅一条与它无关的会话。
    expect(paneState.props?.rootSessionId).toBeUndefined();
  });

  it("workspace scope 从 tab 上原样传给 pane provider（远程同路径工作区不串台）", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(scopeState.scope).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
    });
  });

  it("非 focused 时不上报前台 telemetry", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(paneState.props).toMatchObject({ focused: false, telemetryVisible: false });
  });
});

describe("WorkflowActorSessionSidePane 未启动门", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
    paneState.rendered = [];
    scopeState.scope = null;
    projectionState.snapshot = null;
    leaseState.acquired = [];
    leaseState.release.mockClear();
  });

  it("actor 尚未派发任何节点时渲染占位，且**不挂订阅**", () => {
    // 这就是那个 bug：会话在首个 ask 派发时才创建，提前订阅必然 sessionNotFound，
    // 而投影 store 失败后只等手动 retry。门在这里不让 SessionPane 挂上。
    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "queued", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    const view = renderPane();

    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    // 门要保证的那条**否定**，也是最先该说话的一条：acquire 从没收到过 actor 会话 id。
    // 写成否定而不是 `toEqual(["parent-a"])`，是为了让将来多出一个正当的 acquire 时，
    // 这条断言仍然只说它该说的那件事。
    expect(leaseState.acquired).not.toContain(ACTOR_SESSION_ID);
    // 同时确认门**真的**读到了投影：父会话被订阅了。否则上面那条否定可以靠「什么都没做」通过。
    expect(leaseState.acquired).toContain("parent-a");
    // 连一帧都没渲染过。渲染过一帧就订阅过一次，而失败的 store 会在 keep-warm 里活满 30s
    // 并被后续 acquire 原样复用——那时门放行也换不回一个活面板。
    expect(paneState.rendered).toEqual([]);
    expect(view.queryByTestId("mock-session-pane")).toBeNull();
    expect(paneState.props).toBeNull();
  });

  it("占位文案双语可读", () => {
    projectionState.snapshot = snapshotWith([]);

    const en = renderPane("en-US");
    expect(en.getByTestId("workflow-actor-not-started").textContent).toContain("Not started yet");
    cleanup();

    const zh = renderPane("zh-CN");
    expect(zh.getByTestId("workflow-actor-not-started").textContent).toContain("尚未启动");
  });

  it("投影抬升到 dispatched 后自动换成嵌套 SessionPane（自愈，无需 retry）", () => {
    projectionState.snapshot = snapshotWith([]);
    const view = renderPane();
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();

    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "dispatched", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
      ),
    );

    expect(view.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(view.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(paneState.props).toMatchObject({ sessionId: ACTOR_SESSION_ID, readOnly: true });
    // 自愈的正面证据：门放行后订阅**真的**发生了（首次派发之前它一次都没发生过）。
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("started 与 unknown 都照旧订阅：投影里查不到这个 actor 时绝不拦", () => {
    // run 被 8-run 上限淘汰或冷恢复后投影为空，直接订阅是 transcript 唯一的路——
    // 拦 unknown 等于把已完结 run 的唯一持久视图关死。tab 带着会话 id，就订阅它。
    projectionState.snapshot = snapshotWith([], ACTOR_SESSION_ID, []);
    const unknown = renderPane();
    expect(unknown.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(unknown.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
    cleanup();
    leaseState.acquired = [];

    // 投影整体缺席（父会话还没连上 / 冷启动）同样是 unknown。
    projectionState.snapshot = null;
    const empty = renderPane();
    expect(empty.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("未启动药丸开的槽位 tab（没有会话 id）：占位、不订阅；actor 带着会话出现并派发后自愈", () => {
    // docs/dynamic-workflow/presentation.md「The pill」：tab 可以在 actor 出现之前就开。
    const { actorSessionId: _absent, ...slotTab } = tabOf();
    projectionState.snapshot = snapshotWith([], ACTOR_SESSION_ID, []);
    const view = render(renderTab(slotTab));
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    expect(leaseState.acquired).toContain("parent-a");
    expect(leaseState.acquired).not.toContain(ACTOR_SESSION_ID);
    expect(paneState.rendered).toEqual([]);

    // actor 出现但还没派发：仍是占位（会话 id 已知，但订阅它必然 sessionNotFound）。
    // 面板是 memo 的，桩投影不会自己触发重渲染，所以每次换一个等价的 tab 对象。
    projectionState.snapshot = snapshotWith([]);
    view.rerender(renderTab({ ...slotTab }));
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    expect(paneState.rendered).toEqual([]);

    // 首个节点派发：会话 id 从投影里来，SessionPane 挂上——tab 自己从没拿到过会话 id。
    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "dispatched", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    view.rerender(renderTab({ ...slotTab }));
    expect(view.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(paneState.props).toMatchObject({ sessionId: ACTOR_SESSION_ID, readOnly: true });
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("started 时订阅的是 actor 会话本身，不是父会话的替身", () => {
    // 门是加在 SessionPane **之前**的一层，最容易的接错方式就是把父会话 id 传下去。
    projectionState.snapshot = snapshotWith([
      {
        siteId: "ask#1",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 2,
      },
    ]);
    renderPane();

    // 看去重集合而不是序列：重渲染次数不是契约，"只见过这一个会话 id"才是。
    expect(new Set(paneState.rendered)).toEqual(new Set([ACTOR_SESSION_ID]));
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });
});
