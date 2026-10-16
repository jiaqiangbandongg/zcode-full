// @vitest-environment jsdom

// 工具卡 join 回退的信源：journal-backed 的发现查询（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
// 「发现查询」+「UI 回退的重试语义」）。
//
// 这个 hook 存在的理由就是一个实测失效：查询原本一次性发出、失败即静默 null，而它恰好
// 在会话还冷的时候发出（effect 声明顺序 + CLI 串行派发），于是重启后工具卡永远退回编译态。
// 冷会话前置已在 CLI 侧修好；这里钉住第二半——可重试的那一跳真的重试了。
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

const workflowRuns =
  vi.fn<(params: V4ConversationWorkflowRunsParams) => Promise<V4ConversationWorkflowRunsResult>>();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRuns }),
}));

// eslint-disable-next-line import/first -- 必须在 context mock 之后再引入被测 hook。
import {
  isWorkflowRunsCapabilityMissing,
  useWorkflowRunJournalSummaries,
} from "@/hooks/useWorkflowRunJournalSummaries.js";

function result(runId: string): V4ConversationWorkflowRunsResult {
  return {
    runs: [{ runId, toolCallId: `call-${runId}`, status: "failed", resumable: true }],
  };
}

describe("isWorkflowRunsCapabilityMissing", () => {
  it("能力缺席与普通失败必须分开：前者终局，后者值得再问一次", () => {
    expect(
      isWorkflowRunsCapabilityMissing(
        new Error(
          "capability not supported by this session runtime: listDynamicWorkflowRuns (session s1)",
        ),
      ),
    ).toBe(true);
    expect(isWorkflowRunsCapabilityMissing(new Error("fault.command.capabilityUnsupported"))).toBe(
      true,
    );
    expect(
      isWorkflowRunsCapabilityMissing(new Error("fault.workflowRuns.sessionNotFound: s1")),
    ).toBe(false);
    expect(isWorkflowRunsCapabilityMissing(new Error("socket closed"))).toBe(false);
  });
});

describe("useWorkflowRunJournalSummaries", () => {
  it("首查成功即收口：live 抬升不再多打一次 RPC", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);

    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("冷开首查失败 → live 抬升时重试并补上摘要（这就是那个失效的修复）", async () => {
    workflowRuns.mockReset();
    workflowRuns
      // 会话还没在册：CLI 侧回结构化的 sessionNotFound。
      .mockRejectedValueOnce(new Error("fault.workflowRuns.sessionNotFound: sess-1"))
      .mockResolvedValueOnce(result("dwfrun-1"));
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    expect(hook.result.current).toBeNull();

    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1");
  });

  it("能力缺席不重试：旧 CLI / journal 不可用是稳定事实", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockRejectedValue(
      new Error(
        "capability not supported by this session runtime: listDynamicWorkflowRuns (session sess-1)",
      ),
    );
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("没有 sessionId（草稿会话）时根本不发请求", async () => {
    workflowRuns.mockReset();
    const hook = renderHook(() => useWorkflowRunJournalSummaries({ sessionId: null, live: true }));
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).not.toHaveBeenCalled();
  });

  it("enabled=false（嵌套只读 transcript）不发请求：journal 按父会话建键，拿 actor id 去问只会造出幽灵 runtime", async () => {
    // Bug 根因（2026-08-24 实测）：actor transcript 的嵌套 SessionPane 曾带着 actor 会话 id
    // 发这条查询，CLI 的冷会话前置随即对一条**正在运行**的 detached 会话物化第二个 runtime，
    // 直播冻结在「已工作 xx 秒」。CLI 侧已按 hasLiveConversation 收口；这里钉住 UI 侧的那半：
    // 只读嵌套 pane（actor / subagent transcript）根本不该发出这条父会话专属的查询。
    workflowRuns.mockReset();
    const hook = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-actor-1", live: true, enabled: false }),
    );
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).not.toHaveBeenCalled();
  });

  it("换会话：丢弃旧摘要并重查——上一个会话的 run 绝不能给新会话的卡片做 join", async () => {
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"));
    const hook = renderHook(
      (props: { sessionId: string }) =>
        useWorkflowRunJournalSummaries({ sessionId: props.sessionId, live: true }),
      { initialProps: { sessionId: "sess-1" } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));

    hook.rerender({ sessionId: "sess-2" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));
    expect(workflowRuns).toHaveBeenCalledTimes(2);
  });

  it("切回一个问过的会话：重查一次而不是空着（收口记的是会话 + 答案，不是一个裸的「问过了」）", async () => {
    // 收口只记**最近**那个会话及其答案：只记一个 id 而把答案丢在 state 里的话，切回来会
    // 两头落空——早退不重查，换会话又清了状态，卡片于是永远没有入口。重查一页 journal 很便宜，
    // 空着的入口不便宜。
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"))
      .mockResolvedValueOnce(result("dwfrun-1"));
    const hook = renderHook(
      (props: { sessionId: string }) =>
        useWorkflowRunJournalSummaries({ sessionId: props.sessionId, live: true }),
      { initialProps: { sessionId: "sess-1" } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));
    hook.rerender({ sessionId: "sess-2" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));

    hook.rerender({ sessionId: "sess-1" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));
    expect(workflowRuns).toHaveBeenCalledTimes(3);
  });

  // ── refreshKey：run 目录页与任务岛计数的新鲜度来源 ──
  // 摘要是会话中途也会变的（跑完一个 run 就多一条已结束），但收口语义又必须挡住无谓重查。
  // `refreshKey` 就是这条缝：调用方按「已结算 run 的单调计数」给，跑完一个才抬一次。

  it("refreshKey 不变：仍然只查一次（渲染再多也不多打 RPC）", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 2 } },
    );

    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    hook.rerender({ refreshKey: 2 });
    hook.rerender({ refreshKey: 2 });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("refreshKey 抬升：恰好重取一次并换上新摘要（会话中途跑完一个 run）", async () => {
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"));
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));

    hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));
    expect(workflowRuns).toHaveBeenCalledTimes(2);
  });

  it("能力缺席在 refreshKey 抬升后**仍然**不重探：那是稳定事实，不是新鲜度问题", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockRejectedValue(
      new Error(
        "capability not supported by this session runtime: listDynamicWorkflowRuns (session sess-1)",
      ),
    );
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 0 } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    hook.rerender({ refreshKey: 1 });
    hook.rerender({ refreshKey: 2 });
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("limit 原样传给查询；缺省时不带这个键（由 CLI 侧定缺省）", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const withLimit = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, limit: 64 }),
    );
    await waitFor(() => expect(withLimit.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenLastCalledWith({ sessionId: "sess-1", limit: 64 });

    const withoutLimit = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-2", live: true }),
    );
    await waitFor(() => expect(withoutLimit.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenLastCalledWith({ sessionId: "sess-2" });
  });
});
