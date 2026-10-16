// ReplaceableConversationTransport 的无状态 query 转发面。
//
// 这个类是 pane 侧的**稳定身份**：远程 service proxy 换代时存量 pane 继续持有同一个对象，
// 所以 ConversationTransport 每新增一个成员，这里都必须长出对应的转发方法。漏掉一个不会在
// pane 侧炸得明显——那个 query 只是变成 undefined，功能静静地不存在。workflowRunEvents
// （dwf run 事件日志分页）就漏过一次，所以它在这里有一条用例。
import { describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ReplaceableConversationTransport } from "../src/v4/replaceableConversationTransport.js";
import type { ConversationTransport } from "../src/v4/transport.js";

// 桩只带 workflowRunEvents：这条转发是无状态的（不看订阅 ownership 映射），replace 也不碰
// 接口的其余成员（订阅映射与监听器集合都是空的）。补齐一整张接口只会淹掉用例在测什么。
function stubTransport(result: V4ConversationWorkflowRunEventsResult) {
  const workflowRunEvents = vi.fn(async () => result);
  return {
    workflowRunEvents,
    transport: { workflowRunEvents } as unknown as ConversationTransport,
  };
}

const firstPage: V4ConversationWorkflowRunEventsResult = {
  events: [{ sequence: 7, type: "run.started", payload: { runId: "dwfrun-1" } }],
  hasMore: true,
};
const secondPage: V4ConversationWorkflowRunEventsResult = { events: [], hasMore: false };

describe("ReplaceableConversationTransport workflowRunEvents", () => {
  it("原样转发给当前 transport，params 一个字段不动", async () => {
    const first = stubTransport(firstPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);
    const params = { sessionId: "session-1", runId: "dwfrun-1", afterSequence: 6, limit: 50 };

    await expect(replaceable.workflowRunEvents(params)).resolves.toEqual(firstPage);
    expect(first.workflowRunEvents).toHaveBeenCalledWith(params);
  });

  it("replace 之后转发给新 transport，旧的不再被打", async () => {
    const first = stubTransport(firstPage);
    const second = stubTransport(secondPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);

    replaceable.replace(second.transport);
    const params = { sessionId: "session-1", runId: "dwfrun-1" };

    await expect(replaceable.workflowRunEvents(params)).resolves.toEqual(secondPage);
    expect(second.workflowRunEvents).toHaveBeenCalledWith(params);
    expect(first.workflowRunEvents).not.toHaveBeenCalled();
  });
});

// workflowRuns（dwf run 枚举，重启后的发现面）：与 workflowRunEvents 同一类漏接风险，
// 接口新增成员时这里必须同步长出转发（文件头注释的通则）。
function stubRunsTransport(result: V4ConversationWorkflowRunsResult) {
  const workflowRuns = vi.fn(async () => result);
  return {
    workflowRuns,
    transport: { workflowRuns } as unknown as ConversationTransport,
  };
}

const runsPage: V4ConversationWorkflowRunsResult = {
  runs: [
    {
      runId: "dwfrun-1",
      toolCallId: "call-1",
      status: "cancelled",
      resumable: true,
    },
  ],
};
const emptyRuns: V4ConversationWorkflowRunsResult = { runs: [] };

describe("ReplaceableConversationTransport workflowRuns", () => {
  it("原样转发给当前 transport", async () => {
    const first = stubRunsTransport(runsPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);
    const params = { sessionId: "session-1", limit: 8 };

    await expect(replaceable.workflowRuns(params)).resolves.toEqual(runsPage);
    expect(first.workflowRuns).toHaveBeenCalledWith(params);
  });

  it("replace 之后转发给新 transport，旧的不再被打", async () => {
    const first = stubRunsTransport(runsPage);
    const second = stubRunsTransport(emptyRuns);
    const replaceable = new ReplaceableConversationTransport(first.transport);

    replaceable.replace(second.transport);
    const params = { sessionId: "session-1" };

    await expect(replaceable.workflowRuns(params)).resolves.toEqual(emptyRuns);
    expect(second.workflowRuns).toHaveBeenCalledWith(params);
    expect(first.workflowRuns).not.toHaveBeenCalled();
  });
});

// dwf 用户面产物的三条读面（docs/dynamic-workflow/authoring.md）：与上面两条同一类漏接风险。
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
//
// 这三条比前两条更值得钉：漏掉 workflowRunArtifactRead 的症状是"侧板上有卡片、点开是空的"，
// 而不是一个显式的错误——卡片来自状态键投影（不经本类），字节才走 transport。
describe("ReplaceableConversationTransport 用户面产物与脚本 transcript 的转发", () => {
  /**
   * 三条一起测：每条各写一遍「原样转发 + replace 之后打新的」会是六个几乎一样的用例，
   * 而真正要证明的只有一件事——**接口上的每个成员在这个稳定身份上都有一条转发**。
   */
  const cases = [
    {
      method: "workflowRunArtifacts" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1" },
      first: { artifacts: [] },
      second: {
        artifacts: [
          {
            id: "book",
            kind: "file" as const,
            version: 1,
            versions: [{ version: 1, publishedAt: 1 }],
            itemCount: 0,
          },
        ],
      },
    },
    {
      method: "workflowRunArtifactData" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1", artifactId: "perf", limit: 200 },
      first: { items: [], hasMore: false },
      second: {
        items: [{ sequence: 3, siteId: "report#1", ordinal: 1, item: { round: 1 } }],
        hasMore: true,
      },
    },
    {
      method: "workflowRunArtifactRead" as const,
      params: {
        sessionId: "session-1",
        runId: "dwfrun-1",
        artifactId: "book",
        version: 1,
        offset: 0,
        limit: 4,
      },
      first: { dataBase64: "", mediaType: "application/pdf", totalBytes: 0, nextOffset: null },
      second: {
        dataBase64: "aGVsbG8=",
        mediaType: "application/pdf",
        totalBytes: 5,
        nextOffset: null,
      },
    },
    // 脚本 transcript 的两条读面（docs/dynamic-workflow/transcript-and-notifications.md「Two read queries」）：
    // 与产物同一类漏接风险——清单漏了是「面板一直转圈」，正文漏了是「卡片展开是空的」。
    {
      method: "workflowRunWorkspace" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1" },
      first: { nodes: [] },
      second: {
        nodes: [
          {
            siteId: "world-read#1",
            ordinal: 1,
            kind: "world-read" as const,
            op: "read",
            args: ["src/a.ts"],
            status: "completed" as const,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        truncated: true,
      },
    },
    {
      method: "workflowRunNodeResult" as const,
      params: {
        sessionId: "session-1",
        runId: "dwfrun-1",
        siteId: "world-read#1",
        ordinal: 1,
        maxBytes: 4096,
      },
      first: { status: "running" as const, truncated: false, totalBytes: 0 },
      second: {
        status: "completed" as const,
        result: "export {};\n",
        truncated: false,
        totalBytes: 11,
      },
    },
  ];

  it.each(cases)("$method 原样转发给当前 transport，params 一个字段不动", async (testCase) => {
    const forward = vi.fn(async () => testCase.first);
    const transport = { [testCase.method]: forward } as unknown as ConversationTransport;
    const replaceable = new ReplaceableConversationTransport(transport);

    await expect(
      (replaceable[testCase.method] as (params: unknown) => Promise<unknown>)(testCase.params),
    ).resolves.toEqual(testCase.first);
    expect(forward).toHaveBeenCalledWith(testCase.params);
  });

  it.each(cases)("$method replace 之后转发给新 transport，旧的不再被打", async (testCase) => {
    const firstForward = vi.fn(async () => testCase.first);
    const secondForward = vi.fn(async () => testCase.second);
    const replaceable = new ReplaceableConversationTransport({
      [testCase.method]: firstForward,
    } as unknown as ConversationTransport);

    replaceable.replace({ [testCase.method]: secondForward } as unknown as ConversationTransport);
    await expect(
      (replaceable[testCase.method] as (params: unknown) => Promise<unknown>)(testCase.params),
    ).resolves.toEqual(testCase.second);
    expect(secondForward).toHaveBeenCalledWith(testCase.params);
    expect(firstForward).not.toHaveBeenCalled();
  });
});
