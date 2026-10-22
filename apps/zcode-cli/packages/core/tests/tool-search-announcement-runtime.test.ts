import { expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  ModelErrorCode,
  CompactTrigger,
  type Model,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  countContinuePrompts,
  registerReadOnlyTool,
  requestText,
} from "./runtime-output-token-continuation-test-helpers.js";

const ANNOUNCEMENT = "The following deferred tools are now available via ToolSearch.";
const LATE_TOOL = "LateLookup";
const done = (): ModelResult => ({ text: "done", finishReason: "stop", usage: {} });
const partial = (): ModelResult => ({ text: "partial", finishReason: "length", usage: {} });
const isCompact = (request: ModelRequest) =>
  requestText(request.messages).includes("create a detailed summary");
const announcementCount = (request: ModelRequest) =>
  requestText(request.messages).split(ANNOUNCEMENT).length - 1;

function fixture(
  respond: (request: ModelRequest, index: number) => Promise<ModelResult> | ModelResult = done,
  config: Partial<AgentRuntimeConfig> = {},
) {
  const requests: ModelRequest[] = [];
  const factory = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      return respond(request, requests.length);
    },
  });
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  const runtime = createTestAgentRuntime(
    createSessionId("toolsearch-announcement"),
    {
      toolSearch: { mode: "native" },
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      systemPrompt: "Test tool announcements.",
      toolAllowlist: ["ToolSearch", "Read", "WebFetch", LATE_TOOL],
      ...config,
    },
    { eventStore: createTestSessionEventStore(), modelFactory: (input) => wrap(factory(input)) },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  return { runtime, internal, requests };
}

function announcements(internal: AgentRuntimeInternal) {
  return internal.messageHistory
    .toRuntimeEntries()
    .filter((e) => e.metadata?.toolSearchAnnouncement);
}

function addLateTool(internal: AgentRuntimeInternal) {
  const registry = internal.getToolRegistry();
  registerReadOnlyTool(registry, LATE_TOOL, "done");
  const entry = registry.get(LATE_TOOL)!;
  registry.register(
    { ...entry, metadata: { ...entry.metadata, shouldDefer: true } },
    { silentDuplicateWarning: true },
  );
  internal.invalidateToolCache();
}

it.each(["off", "on"] as const)(
  "keeps the first announcement through three continuations and the next turn (streaming=%s)",
  async (modelStreaming) => {
    const { runtime, internal, requests } = fixture(
      (_request, index) => (index <= 3 ? partial() : done()),
      { modelStreaming },
    );
    await runtime.executeTurn("start");
    await runtime.executeTurn("next user turn");
    expect(requests.map(announcementCount)).toEqual([1, 1, 1, 1, 1]);
    expect(requests.map((r) => countContinuePrompts(r.messages))).toEqual([0, 1, 2, 3, 0]);
    expect(announcements(internal)).toHaveLength(1);
    for (const request of requests.slice(1, 4)) {
      const text = requestText(request.messages);
      expect(text.indexOf(ANNOUNCEMENT)).toBeLessThan(text.indexOf("partial"));
    }
    expect(
      countContinuePrompts(
        internal.messageHistory
          .toRuntimeEntries()
          .flatMap((e) => (e.kind === "attachment" ? [] : [e.message])),
      ),
    ).toBe(0);
  },
);

it.each(["next input", "tool batch"])(
  "waits for %s to announce a tool added during pure continuation",
  async (boundary) => {
    const { runtime, internal, requests } = fixture((_request, index) => {
      if (index === 1) {
        addLateTool(internal);
        return partial();
      }
      if (index === 2 && boundary === "tool batch") {
        return {
          ...done(),
          finishReason: "tool-calls",
          toolCalls: [
            { id: "search-late", name: "ToolSearch", input: { query: `select:${LATE_TOOL}` } },
          ],
        };
      }
      return done();
    });
    await runtime.executeTurn("start");
    if (boundary === "next input") await runtime.executeTurn("continue work");
    expect(requestText(requests[1]!.messages)).not.toContain(LATE_TOOL);
    expect(announcementCount(requests[1]!)).toBe(1);
    expect(requestText(requests[2]!.messages)).toContain(LATE_TOOL);
    expect(announcements(internal)).toHaveLength(2);
    if (boundary === "tool batch") {
      expect(requests[2]!.tools?.find((t) => t.name === LATE_TOOL)?.deferLoading).toBe(true);
    }
    await runtime.executeTurn("next stable turn");
    expect(announcements(internal)).toHaveLength(2);
  },
);

it("rebuilds the full continuation catalog before manual compact returns", async () => {
  const { runtime, internal, requests } = fixture((request) =>
    isCompact(request) ? { ...done(), text: "<summary>Continue the task.</summary>" } : done(),
  );
  await runtime.executeTurn("setup one");
  await runtime.executeTurn("setup two");
  await runtime.executeTurn("/compact");
  expect(announcements(internal)).toHaveLength(1);
  expect(announcements(internal)[0]?.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["WebFetch"],
    removedNames: [],
    readdedNames: [],
  });
  expect(requests.find(isCompact)?.toolSearchEnabled).toBe(false);
  await runtime.executeTurn("next");
  expect(announcements(internal)).toHaveLength(1);
  expect(announcementCount(requests.at(-1)!)).toBe(1);
});

it("uses compact continuation scope without changing the summary tool policy", async () => {
  const { runtime, internal } = fixture((request) =>
    isCompact(request)
      ? { ...done(), text: "<summary>Continue with the scoped tools.</summary>" }
      : done(),
  );
  await runtime.executeTurn("setup one");
  await runtime.executeTurn("setup two");
  const getContinuationTools = vi.fn(() =>
    internal.getTools().filter((t) => t.name !== "ToolSearch"),
  );
  await internal.compactActiveConversation(undefined, createRootTraceContext(), [], {
    getContinuationTools,
  });
  expect(getContinuationTools).toHaveBeenCalledOnce();
  expect(announcements(internal)).toHaveLength(0);
});

it("retains an announcement in the kept tail without appending another", async () => {
  const { runtime, internal } = fixture((request) =>
    isCompact(request)
      ? { ...done(), text: "<summary>Keep the latest context.</summary>" }
      : done(),
  );
  await runtime.executeTurn("setup one");
  await runtime.executeTurn("setup two");
  // 模拟保留段已经含正常 attachment 收集提交的公告；旧公告会随更早的段被压缩。
  const retained = announcements(internal)[0]!;
  internal.messageHistory.addEntries([retained]);
  const result = await internal.compactActiveConversation(undefined, createRootTraceContext(), [], {
    trigger: CompactTrigger.Reactive,
  });
  expect(result.outcome).toBe("compacted");
  expect(result.entries.filter((e) => e.metadata?.toolSearchAnnouncement)).toEqual([retained]);
});

it.each(["auto", "reactive"] as const)(
  "rebuilds announcements during %s compact inside continuation",
  async (trigger) => {
    let mainCalls = 0;
    const { runtime, internal, requests } = fixture(
      (request) => {
        if (isCompact(request))
          return { ...done(), text: "<summary>Continue after compact.</summary>" };
        mainCalls++;
        if (mainCalls === 3)
          return {
            ...partial(),
            usage: { inputTokens: trigger === "auto" ? 39995 : 1, outputTokens: 1 },
          };
        if (mainCalls === 4 && trigger === "reactive") {
          throw Object.assign(new Error("provider context window exceeded"), {
            code: ModelErrorCode.ModelContextExceeded,
          });
        }
        return done();
      },
      trigger === "auto"
        ? { compact: { contextWindow: 40000, bufferTokens: 10, summaryReserveTokens: 0 } }
        : {},
    );
    const compact = vi.spyOn(internal, "compactActiveConversation");
    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    addLateTool(internal);
    const options = { toolDisallowlist: ["WebFetch"] };
    await runtime.executeTurn("continue task", undefined, options);
    expect(compact).toHaveBeenCalledOnce();
    const result = await compact.mock.results[0]!.value;
    expect(result.entries.filter((e) => e.metadata?.toolSearchAnnouncement)).toHaveLength(1);
    expect(announcements(internal)).toHaveLength(1);
    expect(announcements(internal)[0]?.metadata?.toolSearchAnnouncement).toEqual({
      addedNames: [LATE_TOOL],
      removedNames: [],
      readdedNames: [],
    });
    expect(announcementCount(requests.at(-1)!)).toBe(1);
    expect(countContinuePrompts(requests.at(-1)!.messages)).toBe(1);
    await runtime.executeTurn("next stable turn", undefined, options);
    expect(announcements(internal)).toHaveLength(1);
  },
);

it.each(["off", "on"] as const)(
  "restores names from an incremental tail through consecutive reactive compacts (streaming=%s)",
  async (modelStreaming) => {
    let mainCalls = 0;
    const { runtime, internal, requests } = fixture(
      (request) => {
        if (isCompact(request)) return { ...done(), text: "<summary>Continue the task.</summary>" };
        mainCalls++;
        if (mainCalls === 3 || mainCalls === 5)
          throw Object.assign(new Error("provider context window exceeded"), {
            code: ModelErrorCode.ModelContextExceeded,
          });
        return done();
      },
      { modelStreaming, toolAllowlist: ["ToolSearch", "Read", "WebFetch", "TodoWrite"] },
    );
    const registry = internal.getToolRegistry();
    const todo = registry.get("TodoWrite")!;
    registry.unregister("TodoWrite");
    internal.invalidateToolCache();
    const compact = vi.spyOn(internal, "compactActiveConversation");
    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    registry.register(todo);
    internal.invalidateToolCache();
    await runtime.executeTurn("use the expanded catalog");
    expect(compact).toHaveBeenCalledOnce();
    expect(announcements(internal).map((e) => e.metadata?.toolSearchAnnouncement)).toEqual([
      { addedNames: ["TodoWrite"], removedNames: [], readdedNames: [] },
      { addedNames: ["WebFetch"], removedNames: [], readdedNames: [] },
    ]);
    for (let iteration = 0; iteration < 2; iteration++) {
      const request = requests.at(-1)!;
      const text = requestText(request.messages);
      for (const name of ["WebFetch", "TodoWrite"]) {
        expect(text.split("\n").filter((line) => line === name)).toHaveLength(1);
        expect(request.tools?.some((t) => t.name === name)).toBe(false);
      }
      if (iteration === 0) await runtime.executeTurn("keep working");
    }
    expect(compact).toHaveBeenCalledTimes(2);
    const before = announcements(internal);
    await runtime.executeTurn("stable turn");
    expect(announcements(internal)).toEqual(before);
  },
);

it("keeps resident tools available and announces actual removal and restoration once", async () => {
  const { runtime, internal, requests } = fixture();
  addLateTool(internal);
  const registry = internal.getToolRegistry();
  const webFetch = registry.get("WebFetch")!;
  await runtime.executeTurn("start");
  registry.register(
    { ...webFetch, metadata: { ...webFetch.metadata, alwaysLoad: true } },
    { silentDuplicateWarning: true },
  );
  internal.invalidateToolCache();
  await runtime.executeTurn("use resident tools");
  expect(announcements(internal)).toHaveLength(1);
  expect(requests.at(-1)?.tools?.find((t) => t.name === "WebFetch")).toBeDefined();
  expect(requests.at(-1)?.tools?.find((t) => t.name === "WebFetch")?.deferLoading).toBeUndefined();
  expect(requestText(requests.at(-1)!.messages)).not.toContain("no longer available");
  registry.register(webFetch, { silentDuplicateWarning: true });
  internal.invalidateToolCache();
  await runtime.executeTurn("use deferred tools");
  expect(announcements(internal)).toHaveLength(1);
  expect(requests.at(-1)?.tools?.some((t) => t.name === "WebFetch")).toBe(false);
  registry.unregister("WebFetch");
  internal.invalidateToolCache();
  await runtime.executeTurn("use remaining tools");
  expect(announcements(internal).at(-1)?.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: [],
    removedNames: ["WebFetch"],
    readdedNames: [],
  });
  registry.register(webFetch);
  internal.invalidateToolCache();
  await runtime.executeTurn("use restored tools");
  expect(announcements(internal)).toHaveLength(3);
  expect(announcements(internal).at(-1)?.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["WebFetch"],
    removedNames: [],
    readdedNames: ["WebFetch"],
  });
  expect(requestText(requests.at(-1)!.messages)).toContain("available again");
  await runtime.executeTurn("stable turn");
  expect(announcements(internal)).toHaveLength(3);
});

it.each(["persist failure", "cancel"])(
  "does not commit compact announcements on %s",
  async (failure) => {
    const controller = new AbortController();
    const { runtime, internal } = fixture((request) => {
      if (!isCompact(request)) return done();
      if (failure === "cancel") controller.abort();
      return { ...done(), text: "<summary>Candidate summary.</summary>" };
    });
    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    const before = internal.messageHistory.toRuntimeEntries();
    if (failure === "persist failure")
      vi.spyOn(internal, "persistCompactSummary").mockRejectedValue(new Error("persist failed"));
    await expect(
      internal.compactActiveConversation(undefined, createRootTraceContext(), [], {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(internal.messageHistory.toRuntimeEntries()).toEqual(before);
  },
);

// Local 与 Native 共用公告时序；续写只保留已有公告，目录变化延迟到正常收集。
it.each(["off", "on"] as const)(
  "Local keeps its snapshot through three continuations (streaming=%s)",
  async (modelStreaming) => {
    const { runtime, internal, requests } = fixture(
      (_request, index) => {
        if (index === 1) addLateTool(internal);
        return index <= 3 ? partial() : done();
      },
      {
        modelStreaming,
        toolSearch: { mode: "local" },
        toolAllowlist: ["ToolSearch", "DeferredToolCall", "Read", "WebFetch", LATE_TOOL],
      },
    );
    await runtime.executeTurn("start");
    expect(announcements(internal)).toHaveLength(1);
    const notice = "The following deferred tools are available via ToolSearch.";
    expect(
      requests.map((request) => requestText(request.messages).split(notice).length - 1),
    ).toEqual([1, 1, 1, 1]);
    expect(requests.every((request) => request.toolSearchEnabled === false)).toBe(true);
    await runtime.executeTurn("next normal collection");
    expect(announcements(internal)).toHaveLength(2);
    expect(announcements(internal).at(-1)?.metadata?.toolSearchAnnouncement?.addedNames).toEqual([
      LATE_TOOL,
    ]);
  },
);
