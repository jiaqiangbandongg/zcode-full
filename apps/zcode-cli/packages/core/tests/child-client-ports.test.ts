import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { deriveChildClientPorts } from "../src/runtime/helpers/child-client-ports.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../src/runtime/methods/model-runtime-headers.js";

/**
 * docs/zcode-protocol-model-backed-control-requests.md「反向请求的会话路由与终止保证」契约 2。
 *
 * 回归背景（2026-09-09）：dwf actor 与 legacy workflow child 曾把 workspace 级端口原样塞进
 * runtime deps，于是子 runtime 带着自己的 `sess_dwf-…` 去问桌面；桌面找不到 session，
 * response 永不发出，子代理在首个模型请求前挂死。这里钉住派生的三条性质。
 */
describe("deriveChildClientPorts", () => {
  const rootSessionId = createSessionId("root-session");
  const childSessionId = createSessionId("child-session");
  const grandchildSessionId = createSessionId("grandchild-session");

  it("子会话 PAT 恢复通过 core 原端口携带作用域和指纹，仍路由到根会话", async () => {
    const received: unknown[] = [];
    const response = {
      headersApplied: true,
      requestAuth: { apiKey: "fresh-pat", accountScope: "a".repeat(64) },
    };
    const ports = deriveChildClientPorts(
      {
        providerRuntimeHeadersPort: {
          refreshBeforeModelRequest: async (input) => {
            received.push(input);
            return response;
          },
        },
      },
      { agentId: "agent", agentType: "explore", childSessionId, parentSessionId: rootSessionId },
    );
    const refresh = createRefreshRuntimeHeadersBeforeModelAttempt(
      { sessionId: childSessionId, ...ports } as never,
      {
        model: { providerId: "account", modelId: "glm" } as never,
        traceContext: { traceId: createTraceId() },
      },
    )!;
    const recovery = {
      attempt: 2,
      expectedAccountScope: "a".repeat(64),
      rejectedProjectTokenFingerprint: "b".repeat(64),
    };
    expect(await refresh(recovery)).toEqual(response);
    expect(received).toEqual([
      expect.objectContaining({
        sessionId: rootSessionId,
        expectedAccountScope: recovery.expectedAccountScope,
        rejectedProjectTokenFingerprint: recovery.rejectedProjectTokenFingerprint,
      }),
    ]);
  });

  function makeRequest(sessionId = grandchildSessionId): PermissionBrokerRequest {
    return {
      requestId: "req-1",
      sessionId,
      turnId: createTurnId(),
      traceId: createTraceId(),
      toolCallId: createToolCallId(),
      toolName: "Bash",
      input: { command: "ls" },
      mode: "build",
      ruleId: "rule-1",
      reason: "test",
      riskLevel: "low",
      requestedAt: new Date(0),
    } as PermissionBrokerRequest;
  }

  function recordingBroker() {
    const seen: PermissionBrokerRequest[] = [];
    return {
      seen,
      port: {
        requestPermission(request: PermissionBrokerRequest): Promise<PermissionBrokerResult> {
          seen.push(request);
          return Promise.resolve({ decision: "allow" } as PermissionBrokerResult);
        },
      },
    };
  }

  const originContext = {
    agentId: "agent-1",
    agentType: "explore",
    childSessionId,
    description: "child agent",
  };

  function headersInput(sessionId: ReturnType<typeof createSessionId>) {
    return {
      modelId: "model-a",
      providerId: "provider-a",
      reason: "model-request" as const,
      sessionId,
      traceContext: { traceId: createTraceId() } as never,
    };
  }

  it("provider runtime headers 请求改写成父会话；嵌套两层收敛到根", async () => {
    const seen: string[] = [];
    const parentPort = {
      shouldRefreshBeforeModelRequest: () => true,
      refreshBeforeModelRequest: async (input: { sessionId: string }) => {
        seen.push(input.sessionId);
        return { headersApplied: true };
      },
    };

    // root → child
    const childPorts = deriveChildClientPorts(
      { providerRuntimeHeadersPort: parentPort },
      { ...originContext, parentSessionId: rootSessionId },
    );
    await childPorts.providerRuntimeHeadersPort!.refreshBeforeModelRequest(
      headersInput(childSessionId),
    );
    expect(seen).toEqual([rootSessionId]);
    expect(
      childPorts.providerRuntimeHeadersPort!.shouldRefreshBeforeModelRequest?.({
        modelId: "model-a",
        providerId: "provider-a",
      }),
    ).toBe(true);

    // child → grandchild：外层（离客户端更近的一层）最后改写，最终值必然是根会话。
    const grandchildPorts = deriveChildClientPorts(
      { providerRuntimeHeadersPort: childPorts.providerRuntimeHeadersPort! },
      {
        agentId: "agent-2",
        agentType: "general-purpose",
        childSessionId: grandchildSessionId,
        description: "grandchild agent",
        parentSessionId: childSessionId,
      },
    );
    await grandchildPorts.providerRuntimeHeadersPort!.refreshBeforeModelRequest(
      headersInput(grandchildSessionId),
    );
    expect(seen).toEqual([rootSessionId, rootSessionId]);
  });

  it("父没有端口时不合成空实现（键缺席，不是 undefined 值）", () => {
    const derived = deriveChildClientPorts(
      {},
      { ...originContext, parentSessionId: rootSessionId },
    );

    expect("providerRuntimeHeadersPort" in derived).toBe(false);
    expect("permissionBroker" in derived).toBe(false);
  });

  it("permission 请求改写成父会话，并带上子代理 origin", async () => {
    const parent = recordingBroker();

    const derived = deriveChildClientPorts(
      { permissionBroker: parent.port },
      { ...originContext, parentSessionId: rootSessionId },
    );
    await derived.permissionBroker!.requestPermission(makeRequest(childSessionId));

    expect(parent.seen).toHaveLength(1);
    expect(parent.seen[0]!.sessionId).toBe(rootSessionId);
    expect(parent.seen[0]!.origin).toMatchObject({
      kind: "subagent",
      agentId: "agent-1",
      childSessionId,
      parentSessionId: rootSessionId,
    });
  });

  it("嵌套两层：sessionId 收敛到根，origin 保留最内层子代理", async () => {
    const root = recordingBroker();

    // root → child
    const childPorts = deriveChildClientPorts(
      { permissionBroker: root.port },
      { ...originContext, parentSessionId: rootSessionId },
    );
    // child → grandchild（父会话是 child 自己）
    const grandchildPorts = deriveChildClientPorts(
      { permissionBroker: childPorts.permissionBroker! },
      {
        agentId: "agent-2",
        agentType: "general-purpose",
        childSessionId: grandchildSessionId,
        description: "grandchild agent",
        parentSessionId: childSessionId,
      },
    );

    await grandchildPorts.permissionBroker!.requestPermission(makeRequest());

    expect(root.seen).toHaveLength(1);
    // 外层（离客户端更近的一层）最后改写 sessionId，所以最终值是根会话——
    // 客户端只认识它。
    expect(root.seen[0]!.sessionId).toBe(rootSessionId);
    // origin 反过来保留最内层：归属是真正发起请求的孙子代理，不是中间层。
    expect(root.seen[0]!.origin).toMatchObject({
      agentId: "agent-2",
      childSessionId: grandchildSessionId,
    });
  });
});
