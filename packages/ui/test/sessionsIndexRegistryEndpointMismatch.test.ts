import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";

const { lifecycleWarn } = vi.hoisted(() => ({ lifecycleWarn: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    lifecycle: { info: vi.fn(), warn: lifecycleWarn, error: vi.fn() },
  },
}));

import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  resetSessionsIndexScopeEndpointMismatchReportsForTest,
  sessionsIndexRegistrySize,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";

const workspacePath = "/root/src/plancov";
const workspaceIdentity = "remote:wsl:default:root:/root/src/plancov";
const remoteSessionId = "remote-session-plancov";

function mockAgentService(): SessionsIndexAgentService {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "test-connection",
      clientMode: "desktop-continuous" as const,
      deliveryProfile: "continuous" as const,
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none" as const,
      },
      auth: {},
    })),
    initializeConversationV4: vi.fn(async () => {}),
    subscribeSessionsIndexV4: vi.fn(async () => ({
      ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "e1" },
    })),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: { subscriptionId: params.subscriptionId, mode: "snapshot" as const, logEpoch: "e1" },
    })),
    onDynamicSessionsIndexFrame: vi.fn(() => () => ({ dispose: () => {} })),
    onAgentRuntimeRestarted: runtimeRestarts.event,
  } as unknown as SessionsIndexAgentService;
}

const remoteScopeWithoutEndpoint: SessionsIndexScope = {
  workspaceKey: workspaceIdentity,
  workspacePath,
  workspaceIdentity,
};

describe("sessionsIndexRegistry scope endpoint mismatch 观测", () => {
  let remoteService: SessionsIndexAgentService;

  beforeEach(() => {
    lifecycleWarn.mockClear();
    resetSessionsIndexScopeEndpointMismatchReportsForTest();
    remoteService = mockAgentService();
    registerRemoteWorkspaceSession({
      sessionId: remoteSessionId,
      services: { zcodeAgentService: remoteService } as unknown as IServiceAccessor,
    });
  });

  afterEach(() => {
    unregisterRemoteWorkspaceSession(remoteSessionId);
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("远程代理却缺省 endpointKey 时落一条 lifecycle warn，并按 scope 去重", () => {
    const store = acquireSessionsIndex(remoteScopeWithoutEndpoint, remoteService);
    const storeAgain = acquireSessionsIndex(remoteScopeWithoutEndpoint, remoteService);

    expect(lifecycleWarn).toHaveBeenCalledTimes(1);
    expect(lifecycleWarn).toHaveBeenCalledWith(
      "[v4-sessions-index] scope endpoint 与远程代理归属不一致",
      expect.objectContaining({
        event: "v4.sessions_index.scope_endpoint_mismatch",
        endpointKey: "__base__",
        remoteSessionId,
        workspaceKey: workspaceIdentity,
        workspacePath,
      }),
    );

    releaseSessionsIndex(remoteScopeWithoutEndpoint, store);
    releaseSessionsIndex(remoteScopeWithoutEndpoint, storeAgain);
  });

  it("endpointKey 与远程代理归属一致时不告警", () => {
    const scope: SessionsIndexScope = {
      ...remoteScopeWithoutEndpoint,
      endpointKey: remoteSessionId,
    };
    const store = acquireSessionsIndex(scope, remoteService);

    expect(lifecycleWarn).not.toHaveBeenCalled();

    releaseSessionsIndex(scope, store);
  });

  it("endpointKey 指向另一个远程 session 时同样告警", () => {
    const scope: SessionsIndexScope = {
      ...remoteScopeWithoutEndpoint,
      endpointKey: "remote-session-other",
    };
    const store = acquireSessionsIndex(scope, remoteService);

    expect(lifecycleWarn).toHaveBeenCalledTimes(1);
    expect(lifecycleWarn).toHaveBeenCalledWith(
      "[v4-sessions-index] scope endpoint 与远程代理归属不一致",
      expect.objectContaining({ endpointKey: "remote-session-other", remoteSessionId }),
    );

    releaseSessionsIndex(scope, store);
  });

  it("本地 base 代理缺省 endpointKey 属于正常形态，不告警", () => {
    const localService = mockAgentService();
    const scope: SessionsIndexScope = { workspaceKey: "D:\\ws", workspacePath: "D:\\ws" };
    const store = acquireSessionsIndex(scope, localService);

    expect(lifecycleWarn).not.toHaveBeenCalled();

    releaseSessionsIndex(scope, store);
  });
});
