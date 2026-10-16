import { expect, it, vi } from "vitest";
import { createProviderRuntimeHeadersPort } from "../src/zcode-protocol/provider-runtime-headers.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import type { ZCodeProviderRuntimeHeadersRequestParams } from "@zcode/shared";
const workspace = {
  workspacePath: "/work",
  workspaceIdentity: "ssh:host:/work",
  workspaceKey: "ssh:host:/work",
};
it("真实工厂同样装配唯一请求端口，完整账号事实透传而不写旧 ModelRef", async () => {
  const { createWorkspaceZCodeApp } =
    await import("../src/zcode-protocol/workspace-model-runtime.js");
  const requestAuth = { apiKey: "team-key", headers: { "X-Team": "team-a" } };
  const requestClient = vi.fn(
    async (_method: string, _params: ZCodeProviderRuntimeHeadersRequestParams) => ({
      headersApplied: true,
      requestAuth,
    }),
  );
  const createZCodeApp = vi.fn(async (_options: Omit<ZCodeAppOptions, "providerRegistry">) => ({}));
  await createWorkspaceZCodeApp(
    {
      deps: { createZCodeApp },
      requestClient,
      notify: vi.fn(),
    } as unknown as ZCodeProtocolAgentServerContext,
    workspace,
    {},
  );
  const port = createZCodeApp.mock.calls[0]![0].providerRuntimeHeadersPort!;
  const input = {
    sessionId: "session",
    providerId: "account:zai-team-coding-plan",
    modelId: "glm",
    traceContext: { traceId: "test-trace" },
    accountAccess: {
      type: "zhipu-account",
      accountType: "zai",
      mode: "team-coding-plan",
      entitled: true,
    } as const,
    reason: "model-request" as const,
  };
  vi.spyOn(Date, "now").mockReturnValue(1);
  try {
    await expect(port.refreshBeforeModelRequest(input)).resolves.toEqual({
      headersApplied: true,
      requestAuth,
    });
    await port.refreshBeforeModelRequest(input);
    const first = requestClient.mock.calls[0]![1];
    const second = requestClient.mock.calls[1]![1];
    expect(first).toMatchObject({
      workspace,
      modelSelection: { providerId: input.providerId, modelId: "glm" },
      accountAccess: input.accountAccess,
    });
    expect(first).not.toHaveProperty("modelRef");
    expect(second.requestId).not.toBe(first.requestId);
  } finally {
    vi.restoreAllMocks();
  }
});
it("取消 runtime headers 反向 RPC 后向 Host 发送同一请求的专用取消通知", async () => {
  const controller = new AbortController();
  const notify = vi.fn();
  const requestClient = vi.fn(
    (_method, _params, _schema, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );
  const port = createProviderRuntimeHeadersPort(
    { requestClient, notify } as unknown as ZCodeProtocolAgentServerContext,
    workspace,
  );
  const pending = port.refreshBeforeModelRequest({
    traceContext: { traceId: "test-trace" },
    sessionId: "session",
    turnId: "turn",
    providerId: "account:zai-start-plan",
    modelId: "glm",
    reason: "model-request",
    abortSignal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    method: "interaction/providerRuntimeHeadersCancelled",
    trace: { traceId: "test-trace" },
    params: {
      workspace,
      sessionId: "session",
      requestId: requestClient.mock.calls[0]![1].requestId,
    },
  });
});
it("成功或普通错误不发送取消，保留原始响应和失败原因", async () => {
  const notify = vi.fn();
  const response = {
    headersApplied: true,
    requestAuth: { headers: { "X-Runtime-Token": "test" } },
  };
  const requestClient = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockRejectedValueOnce(new Error("network-failure"));
  const port = createProviderRuntimeHeadersPort(
    { requestClient, notify } as unknown as ZCodeProtocolAgentServerContext,
    workspace,
  );
  const input = {
    traceContext: { traceId: "test-trace" },
    sessionId: "session",
    providerId: "account:zai-start-plan",
    modelId: "glm",
    reason: "model-request" as const,
  };
  expect(await port.refreshBeforeModelRequest(input)).toEqual(response);
  await expect(port.refreshBeforeModelRequest(input)).rejects.toThrow("network-failure");
  expect(notify).not.toHaveBeenCalled();
});

// 使用真实 RPC pending/timeout/response 实现，避免 mock 自己制造超时掩盖未配置时限。
it("无人应答在总时限后失败并取消，迟到响应失效且下一请求可以成功", async () => {
  const { ZCodeProtocolAgentServer } = await import("../src/zcode-protocol/server.js");
  vi.useFakeTimers();
  try {
    const server = new ZCodeProtocolAgentServer({ createZCodeApp: vi.fn() });
    const sink = vi.fn();
    server.setNotificationSink(sink);
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    const port = createProviderRuntimeHeadersPort(context, workspace);
    const input = {
      traceContext: { traceId: "timeout-trace" },
      sessionId: "session",
      providerId: "account:zai-start-plan",
      modelId: "glm",
      reason: "model-request" as const,
    };
    const baselineTimers = vi.getTimerCount();
    const result = port.refreshBeforeModelRequest(input).catch((error: unknown) => error);
    const request = sink.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(179_999);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledTimes(2);
    const error = await result;
    expect(error).toMatchObject({ code: -32022 });
    expect((error as Error).message).toContain("request timed out");
    expect((error as Error).cause).toMatchObject({ code: -32022 });
    expect(sink.mock.calls[1]![0]).toEqual({
      method: "interaction/providerRuntimeHeadersCancelled",
      trace: { traceId: "timeout-trace" },
      params: { workspace, sessionId: "session", requestId: request.params.requestId },
    });
    expect(vi.getTimerCount()).toBe(baselineTimers);
    const response = {
      headersApplied: true,
      requestAuth: {
        headers: {
          "X-Runtime-Token": "fresh",
          "X-Runtime-Region": "cn",
        },
      },
    };
    await server.handleMessage({ id: request.id, result: response });
    const next = port.refreshBeforeModelRequest(input);
    const nextRequest = sink.mock.calls[2]![0];
    expect(nextRequest.params.requestId).not.toBe(request.params.requestId);
    await server.handleMessage({ id: nextRequest.id, result: response });
    await expect(next).resolves.toEqual(response);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  } finally {
    vi.useRealTimers();
  }
});

it("闲时 scope 经过执行投影和私有反向 RPC 保留，SSH workspace 身份不变", async () => {
  const { createModelExecutionContext } = await import("../src/zcode-protocol/model-execution.js");
  const {
    zcodeSessionSendParamsSchema,
    zcodeProviderRuntimeHeadersRequestParamsSchema,
    zcodeProviderRuntimeHeadersResponseSchema,
  } = await import("@zcode/shared");
  const accountScope = "a".repeat(64);
  const execution = createModelExecutionContext(
    zcodeSessionSendParamsSchema.parse({
      sessionId: "session",
      content: "continue",
      modelSelection: { providerId: "idle", modelId: "glm" },
      modelExecution: {
        selectionScope: "execution",
        requestAuth: { apiKey: "jwt", accountScope, headers: { "X-Off-Peak-Ticket-ID": "ticket" } },
      },
    }).modelExecution!,
  );
  const auth = await execution.requestDependencies!.requestAuth!.source!.resolve({
    attempt: 1,
    providerId: "idle",
    modelId: "glm",
  });
  expect(auth?.accountScope).toBe(accountScope);
  const requestClient = vi.fn(async (_method, params) => {
    expect(zcodeProviderRuntimeHeadersRequestParamsSchema.parse(params)).toMatchObject({
      expectedAccountScope: accountScope,
      rejectedProjectTokenFingerprint: "b".repeat(64),
      workspace,
    });
    return zcodeProviderRuntimeHeadersResponseSchema.parse({
      headersApplied: true,
      requestAuth: { apiKey: "fresh-pat", accountScope },
    });
  });
  const port = createProviderRuntimeHeadersPort(
    { requestClient, notify: vi.fn() } as unknown as ZCodeProtocolAgentServerContext,
    workspace,
  );
  await expect(
    port.refreshBeforeModelRequest({
      sessionId: "session",
      providerId: "account:bigmodel-off-peak",
      modelId: "glm",
      reason: "model-request",
      traceContext: { traceId: "test-trace" },
      expectedAccountScope: auth?.accountScope,
      rejectedProjectTokenFingerprint: "b".repeat(64),
      accountAccess: {
        type: "zhipu-account",
        accountType: "bigmodel",
        mode: "off-peak",
        entitled: true,
      },
    }),
  ).resolves.toMatchObject({ requestAuth: { apiKey: "fresh-pat", accountScope } });
});
