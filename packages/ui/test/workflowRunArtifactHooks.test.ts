// @vitest-environment jsdom

// 用户面产物的三条取数（docs/dynamic-workflow/authoring.md「How the user sees them」）：
//
//   元数据  useWorkflowRunArtifacts     活投影摘要 ⊕ journal 全量（spec / versions 只有后者有）
//   条目    useWorkflowRunArtifactData  itemCount 抬升即增量续拉（看板是 journal 的投影）
//   字节    useWorkflowRunArtifactBytes 分块拼 Uint8Array → Blob → objectUrl（卸载 revoke）
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是引擎内部那个
// 「脚本顶层返回值」的同名词（spec 的「术语」表）。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  WorkflowRunArtifact,
  WorkflowRunArtifactSummary,
} from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const workflowRunArtifacts =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactsParams,
    ) => Promise<V4ConversationWorkflowRunArtifactsResult>
  >();
const workflowRunArtifactData =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactDataParams,
    ) => Promise<V4ConversationWorkflowRunArtifactDataResult>
  >();
const workflowRunArtifactRead =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactReadParams,
    ) => Promise<V4ConversationWorkflowRunArtifactReadResult>
  >();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    workflowRunArtifacts,
    workflowRunArtifactData,
    workflowRunArtifactRead,
  }),
}));

// eslint-disable-next-line import/first -- 必须在 context mock 之后再引入被测 hook。
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
// eslint-disable-next-line import/first
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
// eslint-disable-next-line import/first
import {
  encodeBytesToBase64,
  useWorkflowRunArtifactBytes,
} from "@/hooks/useWorkflowRunArtifactBytes.js";

const SESSION = "parent-a";
const RUN = "dwfrun-1";

function journalRecord(overrides: Partial<WorkflowRunArtifact> = {}): WorkflowRunArtifact {
  return {
    id: "perf",
    kind: "chart",
    version: 1,
    versions: [
      { version: 1, publishedAt: 10, spec: { x: { field: "round" }, y: { field: "ms" } } },
    ],
    spec: { x: { field: "round" }, y: { field: "ms" } },
    itemCount: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<WorkflowRunArtifactSummary> = {}): WorkflowRunArtifactSummary {
  return { id: "perf", kind: "chart", version: 1, itemCount: 0, ...overrides };
}

function itemsPage(
  from: number,
  count: number,
  hasMore: boolean,
): V4ConversationWorkflowRunArtifactDataResult {
  return {
    items: Array.from({ length: count }, (_unused, index) => ({
      sequence: from + index,
      siteId: "report#1",
      ordinal: from + index,
      item: { round: from + index, ms: 100 + index },
    })),
    hasMore,
  };
}

beforeEach(() => {
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactRead.mockReset();
  workflowRunArtifacts.mockResolvedValue({ artifacts: [] });
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
});

describe("useWorkflowRunArtifacts", () => {
  it("run 在活投影里：顺序与新鲜度归摘要，spec / versions 由 journal 补齐", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [journalRecord({ id: "book", kind: "file", spec: undefined }), journalRecord()],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        live: [summary({ itemCount: 3 }), summary({ id: "book", kind: "file" })],
      }),
    );

    // 等的是 **journal 那一半**：活投影已经能给出两条，所以 `toHaveLength(2)` 在第一帧就成立，
    // 用它当门会在负载高时抢在查询返回之前断言 spec（一条只在满载时红的用例）。
    await waitFor(() => expect(hook.result.current.artifacts[0]?.spec).toBeDefined());
    expect(hook.result.current.artifacts).toHaveLength(2);
    // 顺序跟着活投影（perf 在前），不是 journal 返回的顺序。
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual(["perf", "book"]);
    expect(hook.result.current.source).toBe("live");
    // itemCount 取活投影（刷新信号，落后一拍就少画一个点）；spec 只有 journal 有。
    expect(hook.result.current.artifacts[0]?.itemCount).toBe(3);
    expect(hook.result.current.artifacts[0]?.spec).toEqual({
      x: { field: "round" },
      y: { field: "ms" },
    });
    expect(hook.result.current.artifacts[0]?.versions).toHaveLength(1);
  });

  it("run 不在活投影里（冷恢复 / 被 8-run 上限淘汰）：整份清单走 journal", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord({
          id: "audit",
          kind: "file",
          spec: undefined,
          version: 2,
          versions: [
            { version: 1, publishedAt: 1, bytes: 10 },
            { version: 2, publishedAt: 2, bytes: 4096, contentType: "application/pdf" },
          ],
          contentType: "application/pdf",
        }),
      ],
    });
    const hook = renderHook(() => useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN }));

    await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(1));
    expect(hook.result.current.source).toBe("journal");
    // journal 的元素不带 bytes（字节挂在版本上）——从最新版上取。
    expect(hook.result.current.artifacts[0]?.bytes).toBe(4096);
    expect(hook.result.current.artifacts[0]?.version).toBe(2);
  });

  it("投影上界 32 拒新之后，journal 里多出来的产物仍然追加在末尾", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord(),
        journalRecord({ id: "extra", kind: "markdown", spec: undefined }),
      ],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: [summary()] }),
    );

    await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual(["perf", "extra"]);
  });

  // 交付物（docs/dynamic-workflow/authoring.md「Ids, tags and versions」）：活投影按发布顺序 upsert，这里是它唯一的排序点。
  it("交付物带头（活投影把它排在第三也一样），旗子两个来源任一带上即算；其余保持发布顺序", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord(),
        journalRecord({ id: "notes", kind: "markdown", spec: undefined }),
        journalRecord({
          id: "report",
          kind: "markdown",
          spec: undefined,
          description: "结论与修复建议",
          primary: true,
        }),
      ],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        // 活投影的摘要**没带**旗子（老 CLI）：journal 补上之后仍然领头。
        live: [summary(), summary({ id: "notes", kind: "markdown" }), summary({ id: "report", kind: "markdown" })],
      }),
    );
    await waitFor(() => expect(hook.result.current.artifacts[0]?.id).toBe("report"));
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual([
      "report",
      "perf",
      "notes",
    ]);
    expect(hook.result.current.artifacts[0]?.primary).toBe(true);
    expect(hook.result.current.artifacts[0]?.description).toBe("结论与修复建议");
    expect("primary" in hook.result.current.artifacts[1]!).toBe(false);

    // 只有活投影带旗子（journal 还没回来）：第一帧就领头。
    const liveOnly = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: "dwfrun-2",
        live: [summary(), summary({ id: "report", kind: "markdown", primary: true })],
      }),
    );
    expect(liveOnly.result.current.artifacts.map((artifact) => artifact.id)).toEqual([
      "report",
      "perf",
    ]);
  });

  it("能力缺席不是错误：内容产物仍从活投影列得出来，只是 unavailable 抬起", async () => {
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        live: [summary({ id: "book", kind: "file", bytes: 12 })],
      }),
    );

    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.artifacts).toHaveLength(1);
    expect(hook.result.current.artifacts[0]?.spec).toBeUndefined();
  });

  // 完成卡的 `+N` 据它写数字还是省略号（docs/dynamic-workflow/transcript-and-notifications.md「The card」）。
  it("complete：活投影在场即完整（上界 32 = 引擎上限）；冷路径要等 journal 答过；能力缺席永不完整", async () => {
    const live = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: [summary()] }),
    );
    expect(live.result.current.complete).toBe(true);

    let resolve!: (value: { artifacts: WorkflowRunArtifact[] }) => void;
    workflowRunArtifacts.mockImplementation(
      () => new Promise<{ artifacts: WorkflowRunArtifact[] }>((r) => (resolve = r)),
    );
    const cold = renderHook(() => useWorkflowRunArtifacts({ sessionId: SESSION, runId: "dwfrun-c" }));
    expect(cold.result.current.complete).toBe(false);
    resolve({ artifacts: [journalRecord()] });
    await waitFor(() => expect(cold.result.current.complete).toBe(true));

    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const old = renderHook(() => useWorkflowRunArtifacts({ sessionId: SESSION, runId: "dwfrun-o" }));
    await waitFor(() => expect(old.result.current.unavailable).toBe(true));
    expect(old.result.current.complete).toBe(false);
  });

  it("itemCount 变化**不**重查 journal，版本抬升才重查", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [journalRecord()] });
    const hook = renderHook(
      (props: { live: readonly WorkflowRunArtifactSummary[] }) =>
        useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: props.live }),
      {
        initialProps: {
          live: [summary({ itemCount: 1 })] as readonly WorkflowRunArtifactSummary[],
        },
      },
    );
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalledTimes(1));

    hook.rerender({ live: [summary({ itemCount: 2 })] });
    await act(async () => {});
    expect(workflowRunArtifacts).toHaveBeenCalledTimes(1);

    hook.rerender({ live: [summary({ itemCount: 2, version: 2 })] });
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalledTimes(2));
  });

  it("enabled 为 false 时一次都不查", async () => {
    renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, enabled: false, live: [] }),
    );
    await act(async () => {});
    expect(workflowRunArtifacts).not.toHaveBeenCalled();
  });
});

describe("useWorkflowRunArtifactData", () => {
  it("首次整份重取，hasMore 为真就一路翻到排空", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      .mockResolvedValueOnce(itemsPage(3, 1, false));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(1, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      limit: 200,
    });
    // 第二页从上一页末尾的 sequence 续上——不重不漏。
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 2,
      limit: 200,
    });
  });

  it("翻页没有 16 页的上限：一个已结束、打了 5,000 条标签的 run 看板画出全部条目", async () => {
    // 修复前最多翻 16 页 × 200 = 3,200 条就停，而已结束的 run 不会再有 itemCount 变化来续拉。
    const total = 5_000;
    const pages = Math.ceil(total / 200);
    for (let page = 0; page < pages; page += 1) {
      const from = 1 + page * 200;
      const count = Math.min(200, total - page * 200);
      workflowRunArtifactData.mockResolvedValueOnce(itemsPage(from, count, page < pages - 1));
    }
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(total));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(pages);
    expect(hook.result.current.items.at(-1)?.sequence).toBe(total);
  });

  it("一页没有让游标前进就停：一个总说 hasMore 的实现锁不死渲染线程", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      // 同一段 sequence 又来一遍，且仍说还有：游标没有前进。
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      .mockResolvedValue(itemsPage(1, 2, true));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(2);
  });

  it("给了 fields 就只让 CLI 取这些字段", async () => {
    workflowRunArtifactData.mockResolvedValueOnce({
      items: [{ sequence: 1, siteId: "report#1", ordinal: 1, fields: { round: 1 } }],
      hasMore: false,
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: "parent-fields",
        runId: RUN,
        artifactId: "perf",
        fields: ["round", "ms"],
      }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(workflowRunArtifactData).toHaveBeenCalledWith({
      sessionId: "parent-fields",
      runId: RUN,
      artifactId: "perf",
      limit: 200,
      fields: ["round", "ms"],
    });
    expect(hook.result.current.items[0]?.fields).toEqual({ round: 1 });
  });

  it("老 CLI 拒收 fields 时退回取整条 item，并记住这个会话", async () => {
    // 老 CLI 的 strict schema 整条拒收带 fields 的请求；错误跨 JSON-RPC 后只剩 zod 的 message。
    const rejection = new Error(
      '[{"code":"unrecognized_keys","keys":["fields"],"path":[],"message":"Unrecognized key: \\"fields\\""}]',
    );
    workflowRunArtifactData
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(itemsPage(1, 1, false))
      .mockResolvedValueOnce(itemsPage(1, 1, false));
    const request = { sessionId: "parent-old-cli", runId: RUN, artifactId: "perf" };
    const first = renderHook(() => useWorkflowRunArtifactData({ ...request, fields: ["round"] }));
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    expect(first.result.current.error).toBeNull();
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(1, {
      ...request,
      limit: 200,
      fields: ["round"],
    });
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(2, { ...request, limit: 200 });

    // 同一会话的下一块看板不再撞一次拒绝。
    const second = renderHook(() =>
      useWorkflowRunArtifactData({ ...request, artifactId: "perf", fields: ["round"] }),
    );
    await waitFor(() => expect(second.result.current.items).toHaveLength(1));
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(3, { ...request, limit: 200 });
  });

  it("别的错误照常报出来，不当成老 CLI", async () => {
    workflowRunArtifactData.mockRejectedValueOnce(new Error("fault.workflowRunArtifactData.boom"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: "parent-other-error",
        runId: RUN,
        artifactId: "perf",
        fields: ["round"],
      }),
    );
    await waitFor(() => expect(hook.result.current.error).toContain("boom"));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(1);
  });

  it("itemCount 抬升即带 afterSequence 增量续拉", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, false))
      .mockResolvedValueOnce(itemsPage(3, 1, false));
    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 2 } },
    );
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(1);

    hook.rerender({ itemCount: 3 });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 2,
      limit: 200,
    });
  });

  it("本地一条都还没有时，itemCount 抬升照样拉——脚本顶部声明的看板就是这样长出第一个点的", async () => {
    // 回归：旧实现在增量 effect 上有一条「items 为空就不拉」的门，于是一个「先声明、
    // 后每轮 report」的看板永远停在空态（首帧的整份重取只会取到零条）。
    workflowRunArtifactData
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce(itemsPage(1, 1, false));
    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 0 } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.items).toHaveLength(0);

    hook.rerender({ itemCount: 1 });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  });

  it("拉取途中来的刷新信号不丢：收尾前补拉一轮", async () => {
    // 回归：单飞门挡下的那一次如果直接丢掉，一个 run 的**最后一条** report 就永远画不出来
    // ——它之后不会再有 itemCount 变化来触发下一次拉取。
    let releaseFirst: (() => void) | undefined;
    workflowRunArtifactData.mockImplementationOnce(
      async () =>
        await new Promise<V4ConversationWorkflowRunArtifactDataResult>((resolve) => {
          releaseFirst = () => resolve(itemsPage(1, 1, false));
        }),
    );
    workflowRunArtifactData.mockResolvedValueOnce(itemsPage(2, 1, false));

    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 1 } },
    );
    await waitFor(() => expect(releaseFirst).toBeDefined());

    // 第一页还没回来就又来了一条 report：这一次会被单飞门挡下，但必须被记住。
    hook.rerender({ itemCount: 2 });
    await act(async () => {
      releaseFirst?.();
    });

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 1,
      limit: 200,
    });
  });

  it("换产物先清空再整份重取：别的看板的点不留在这块画布上", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, false))
      .mockResolvedValueOnce(itemsPage(9, 1, false));
    const hook = renderHook(
      (props: { artifactId: string }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: props.artifactId,
        }),
      { initialProps: { artifactId: "perf" } },
    );
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));

    hook.rerender({ artifactId: "other" });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(hook.result.current.items[0]?.sequence).toBe(9);
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "other",
      limit: 200,
    });
  });

  it("enabled 为 false（内容产物的 tab）时一次都不查", async () => {
    renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "perf",
        enabled: false,
        itemCount: 5,
      }),
    );
    await act(async () => {});
    expect(workflowRunArtifactData).not.toHaveBeenCalled();
  });

  it("能力缺席抬起 unavailable，而不是报一个错给用户看", async () => {
    workflowRunArtifactData.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );
    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
    expect(hook.result.current.error).toBeNull();
  });
});

describe("useWorkflowRunArtifactBytes", () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    // jsdom 没有 object URL：桩出来才能观察「换版本 / 卸载时 revoke」这条不变式。
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (
      blob: Blob,
    ) => {
      const url = `blob:artifact-${created.length}-${blob.size}`;
      created.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (
      url: string,
    ) => {
      revoked.push(url);
    };
  });

  function chunk(
    text: string,
    nextOffset: number | null,
    totalBytes: number,
  ): V4ConversationWorkflowRunArtifactReadResult {
    return {
      dataBase64: encodeBytesToBase64(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>),
      mediaType: "text/markdown",
      totalBytes,
      nextOffset,
    };
  }

  it("按 nextOffset 分块读到底，拼成一份完整字节 + Blob + objectUrl", async () => {
    workflowRunArtifactRead
      .mockResolvedValueOnce(chunk("hello ", 6, 11))
      .mockResolvedValueOnce(chunk("world", null, 11));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );

    await waitFor(() => expect(hook.result.current.bytes).not.toBeNull());
    expect(new TextDecoder().decode(hook.result.current.bytes!)).toBe("hello world");
    expect(hook.result.current.mediaType).toBe("text/markdown");
    expect(hook.result.current.totalBytes).toBe(11);
    expect(hook.result.current.blob?.type).toBe("text/markdown");
    expect(hook.result.current.objectUrl).toBe(created[0]);
    // 第二块的 offset 来自第一块的 nextOffset，limit 是附件那条既有的分块上界。
    expect(workflowRunArtifactRead).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "notes",
      version: 1,
      offset: 6,
      limit: 512 * 1024,
    });
  });

  it("翻版本会 revoke 上一版的 objectUrl（否则每翻一版漏一份字节）", async () => {
    workflowRunArtifactRead
      .mockResolvedValueOnce(chunk("v1", null, 2))
      .mockResolvedValueOnce(chunk("v2 body", null, 7));
    const hook = renderHook(
      (props: { version: number }) =>
        useWorkflowRunArtifactBytes({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "notes",
          version: props.version,
        }),
      { initialProps: { version: 1 } },
    );
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[0]));

    hook.rerender({ version: 2 });
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[1]));
    expect(revoked).toContain(created[0]);
  });

  it("卸载时 revoke", async () => {
    workflowRunArtifactRead.mockResolvedValueOnce(chunk("bye", null, 3));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[0]));

    hook.unmount();
    expect(revoked).toContain(created[0]);
  });

  it("预置看板（enabled 为 false）不读一个字节", async () => {
    renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "perf",
        version: 1,
        enabled: false,
      }),
    );
    await act(async () => {});
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });

  it("读失败落到 error，而不是留一个半截的 Blob", async () => {
    workflowRunArtifactRead.mockRejectedValueOnce(new Error("store gone"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.error).toBe("store gone"));
    expect(hook.result.current.bytes).toBeNull();
    expect(hook.result.current.objectUrl).toBeNull();
  });
});
