/**
 * 假 provider 服务器的自测（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）：用**真**
 * `AiSdkModelAdapter` 直连，不起 run。钉住的是矩阵赖以成立的几条事实——两种 wire 的成功帧
 * 被真 adapter 解析成同一个工具调用；各种判决经真实 fetch 包装 → 业务码 → 分类器之后落到
 * 预期的 reason / providerCode；`retry-after-ms` 真的被 runner 采用。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ModelRetryBudget,
  runWithModelInvocationContext,
  SUBMIT_RESULT_TOOL_NAME,
  type Model,
  type ModelEvent,
  type ModelInputMessage,
  type ModelNetworkStatusEvent,
  type ModelRequest,
  type ModelToolContract,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "@zcode/adapters/model";
import {
  startFakeProviderServer,
  type FakeProviderServer,
  type FaultProgram,
  type WireFormat,
} from "./helpers/fake-provider-server.js";
import { always, AUTH_401, BUSY_3008, failFirst, healthy } from "./helpers/fault-programs.js";
import {
  createFaultModelFactory,
  FAULT_MODEL_SELECTION,
  type FaultProviderModelOptions,
} from "./helpers/fault-provider-model.js";

const FORMATS: readonly WireFormat[] = ["anthropic-messages", "openai-chat-completions"];

const TOOLS: ModelToolContract[] = [
  {
    name: "Glob",
    description: "find files",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: SUBMIT_RESULT_TOOL_NAME,
    description: "submit",
    inputSchema: {
      type: "object",
      properties: { result: { type: "object", properties: { note: { type: "string" } } } },
      required: ["result"],
    },
  },
];

const FIRST_TURN: ModelInputMessage[] = [{ role: "user", content: "Do the work." }];

/** 已经跑过一轮 Glob 的对话：assistant 工具调用 + tool 结果。 */
const AFTER_ONE_TOOL_RESULT: ModelInputMessage[] = [
  ...FIRST_TURN,
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-glob-1", name: "Glob", input: { pattern: "**/*.md" } }],
  },
  { role: "tool", content: "[]", toolCallId: "call-glob-1", toolName: "Glob" },
];

interface Rig {
  server: FakeProviderServer;
  model: Model;
  statusEvents: ModelNetworkStatusEvent[];
  dispose(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

async function rig(
  apiFormat: WireFormat,
  program: FaultProgram,
  options: Partial<FaultProviderModelOptions> & { turns?: number } = {},
): Promise<Rig> {
  const server = await startFakeProviderServer({
    program,
    ...(options.turns === undefined ? {} : { canned: { turns: options.turns } }),
  });
  const statusEvents: ModelNetworkStatusEvent[] = [];
  const factory = createFaultModelFactory({
    apiFormat,
    baseURL: server.baseURL,
    statusSink: { publish: (event) => void statusEvents.push(event) },
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
  });
  const model = factory.modelFactory({ selection: FAULT_MODEL_SELECTION });
  const built: Rig = {
    server,
    model,
    statusEvents,
    dispose: async () => {
      factory.dispose();
      await server.close();
    },
  };
  rigs.push(built);
  return built;
}

function request(messages: ModelInputMessage[]): ModelRequest {
  return { messages, tools: TOOLS, options: { maxOutputTokens: 1024 } };
}

async function collectStream(
  model: Model,
  messages: ModelInputMessage[],
  budget: ModelRetryBudget | undefined,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const iterable = runWithModelInvocationContext(
    budget === undefined ? {} : { modelRetryBudget: budget },
    () => model.streamText(request(messages)),
  );
  for await (const event of iterable) events.push(event);
  return events;
}

async function rejectionOf(work: () => Promise<unknown>): Promise<AiSdkModelAdapterError> {
  const rejection = await work().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
  return rejection as AiSdkModelAdapterError;
}

function toolCallsOf(events: ModelEvent[]): { name: string; input: unknown }[] {
  return events
    .filter((event): event is Extract<ModelEvent, { type: "tool_call" }> => event.type === "tool_call")
    .map((event) => ({ name: event.toolCall.name, input: event.toolCall.input }));
}

/** 一次性 fail-fast 的重试选项：只钉 reason，不在本文件里等退避。 */
const NO_RETRY = { baseDelayMs: 1, jitter: false, maxAttempts: 1, maxDelayMs: 1 };

describe.each(FORMATS)("fake provider server — %s", (apiFormat) => {
  it("serve: the real adapter parses the streamed canned turn into a Glob call, then submit_result", async () => {
    const { model, server } = await rig(apiFormat, healthy(), { turns: 1 });

    const first = await collectStream(model, FIRST_TURN, ModelRetryBudget.Unbounded);
    expect(toolCallsOf(first)).toEqual([{ name: "Glob", input: { pattern: "**/*.md" } }]);

    const second = await collectStream(model, AFTER_ONE_TOOL_RESULT, ModelRetryBudget.Unbounded);
    expect(toolCallsOf(second)).toEqual([
      { name: SUBMIT_RESULT_TOOL_NAME, input: { result: { note: "done" } } },
    ]);

    expect(server.requests.map((entry) => [entry.route, entry.stream, entry.toolResultCount])).toEqual([
      [apiFormat, true, 0],
      [apiFormat, true, 1],
    ]);
    expect(server.requests.every((entry) => entry.servedStatus === 200 && !entry.closedByClient)).toBe(true);
  });

  it("serve: the non-stream path yields the same tool calls", async () => {
    const { model, server } = await rig(apiFormat, healthy(), { turns: 1 });

    const result = await runWithModelInvocationContext({}, () => model.generateText(request(AFTER_ONE_TOOL_RESULT)));
    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls?.map((call) => [call.name, call.input])).toEqual([
      [SUBMIT_RESULT_TOOL_NAME, { result: { note: "done" } }],
    ]);
    expect(server.requests[0]?.stream).toBe(false);
  });

  it("status 429 + error.code 3008: providerCode 3008, reason rate_limited (bounded budget fails fast)", async () => {
    const { model } = await rig(apiFormat, always(BUSY_3008), { retry: NO_RETRY });
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, undefined));
    expect(error.context).toMatchObject({ providerCode: "3008", reason: "rate_limited", statusCode: 429 });
  });

  it("status 429 with a top-level {code,msg} body and text/plain content-type still yields providerCode 3008", async () => {
    const { model } = await rig(
      apiFormat,
      always({ ...BUSY_3008, bodyShape: "top-level", headers: { "content-type": "text/plain" } }),
      { retry: NO_RETRY },
    );
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, undefined));
    expect(error.context).toMatchObject({ providerCode: "3008", reason: "rate_limited" });
  });

  it("status 401 + error.code 1006: reason auth_failed even under the unbounded workflow budget", async () => {
    const { model } = await rig(apiFormat, always(AUTH_401));
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, ModelRetryBudget.Unbounded));
    expect(error.context).toMatchObject({ providerCode: "1006", reason: "auth_failed", retryable: false });
  });

  it("stream_error frame: an in-stream business error carries providerCode 3008", async () => {
    const { model } = await rig(
      apiFormat,
      always({ kind: "stream_error", code: "3008", message: "user concurrency limit exceeded" }),
      { retry: NO_RETRY },
    );
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, undefined));
    expect(error.context).toMatchObject({ providerCode: "3008", reason: "rate_limited" });
  });

  it("cut after visible output: the runner does not replay and reports streamOutputCommitted", async () => {
    const { model, statusEvents } = await rig(apiFormat, always({ kind: "cut", after: "visible" }));
    await rejectionOf(() => collectStream(model, FIRST_TURN, ModelRetryBudget.Unbounded));
    const failed = statusEvents.filter((event) => event.type === "model_request_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ streamOutputCommitted: true });
    expect(statusEvents.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(0);
  });

  it("cut before visible output: the runner retries and the next attempt completes", async () => {
    const { model, server } = await rig(apiFormat, failFirstCut(1), { turns: 1 });
    const events = await collectStream(model, FIRST_TURN, ModelRetryBudget.Unbounded);
    expect(toolCallsOf(events)).toEqual([{ name: "Glob", input: { pattern: "**/*.md" } }]);
    expect(server.requests.map((entry) => entry.verdict.kind)).toEqual(["cut", "serve"]);
  });

  it("reset: the connection drop classifies as a network error", async () => {
    const { model } = await rig(apiFormat, always({ kind: "reset" }), { retry: NO_RETRY });
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, undefined));
    expect(error.context).toMatchObject({ reason: "network_error" });
  });

  it("hang: the stream idle timeout fires and classifies as stream_idle_timeout", async () => {
    const { model } = await rig(apiFormat, always({ kind: "hang" }), {
      retry: NO_RETRY,
      streamIdleTimeoutMs: 200,
    });
    const error = await rejectionOf(() => collectStream(model, FIRST_TURN, undefined));
    expect(error.context).toMatchObject({ reason: "stream_idle_timeout" });
  });

  it("retry-after-ms 20 on a plain 429 is adopted as the retry delay under the unbounded budget", async () => {
    const { model, statusEvents, server } = await rig(apiFormat, failFirst(1, 429), { turns: 1 });
    const events = await collectStream(model, FIRST_TURN, ModelRetryBudget.Unbounded);
    expect(toolCallsOf(events)).toHaveLength(1);
    const scheduled = statusEvents.filter(
      (event): event is Extract<ModelNetworkStatusEvent, { type: "model_retry_scheduled" }> =>
        event.type === "model_retry_scheduled",
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(20);
    expect(scheduled[0]?.reason).toBe("rate_limited");
    expect(server.requests.map((entry) => entry.servedStatus)).toEqual([429, 200]);
  });
});

/** 第一个请求在 message_start 之后切断，其余放行。 */
function failFirstCut(n: number): FaultProgram {
  return (request) => (request.ordinal <= n ? { kind: "cut", after: "message_start" } : { kind: "serve" });
}
