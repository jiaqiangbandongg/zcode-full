import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  zcodeProtocolMethods,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

// DWG-02（docs/dynamic-workflow/launch.md「Gray release」）：Host 是灰度的唯一裁决者。
// 判定在 workspace client 就绪时做一次：开启才下发 workspace/updateDynamicWorkflowPolicy，
// 并在 session create / resume / v4 createSession 上打 dynamicWorkflowEnabled:true；
// 关闭时三处都不写字段（CLI 缺省 fail-closed）。旧 CLI 的 -32601 降级忽略。
// 与 Off-Peak 不同：远程 workspace 同样可用，判据里不看 workspaceIdentity / remoteSessionId。

const WORKSPACE_PATH = "/workspace/app";

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
}

function sessionSnapshot(sessionId: string) {
  return {
    session: { sessionId, traceId: undefined },
    messages: [],
    settings: { model: { current: undefined } },
  };
}

async function setup(params: {
  /** undefined = 未装配 resolver（纯 CLI / 未接入的装配）。 */
  enabled?: boolean;
  configResolver?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  policyResponse?: (request: unknown) => unknown | Promise<unknown>;
  /** 本机设置权威：每次使用时读用户选择（launch.md「The user's choice」）。 */
  userModeResolver?: () => Promise<DynamicWorkflowMode | undefined>;
  forwardUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
}) {
  const resolveConfig = vi.fn(
    params.configResolver ??
      (async (): Promise<DynamicWorkflowClientConfig> =>
        createDynamicWorkflowClientConfig(
          params.enabled ? "alwaysOn" : "disabled",
          params.enabled ? "remote" : "default",
        )),
  );
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy) {
      if (params.policyResponse) return params.policyResponse(requestParams);
      return requestParams;
    }
    if (method === zcodeProtocolMethods.sessionCreate) {
      return sessionSnapshot("session-created");
    }
    if (method === zcodeProtocolMethods.sessionResume) {
      return sessionSnapshot("session-resumed");
    }
    if (method === V4_METHODS.command) {
      return {
        status: "accepted",
        commandId: (requestParams as { commandId: string }).commandId,
        result: { type: "createSession", sessionId: "v4-session" },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      getClient = getClient;
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => offPeakSelectionView() },
    ...(params.enabled === undefined && !params.configResolver
      ? {}
      : { resolveDynamicWorkflowClientConfig: resolveConfig }),
    ...(params.userModeResolver ? { resolveDynamicWorkflowUserMode: params.userModeResolver } : {}),
    ...(params.forwardUserMode ? { forwardDynamicWorkflowUserMode: params.forwardUserMode } : {}),
  });
  return { service, request, getClient, resolveConfig };
}

function policyCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(
    ([method]) => method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
  );
}

function paramsOf(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.filter(([called]) => called === method).map(([, value]) => value);
}

function v4CreateSessionEnvelope(commandId: string) {
  return {
    commandId,
    clientId: "client-dwf",
    sessionId: null,
    type: "createSession" as const,
    payload: { workspaceId: WORKSPACE_PATH },
    issuedAt: 1700000000000,
  };
}

describe("workspace/updateDynamicWorkflowPolicy 同步（DWG-02）", () => {
  it("未装配灰度 resolver 时不发策略请求", async () => {
    const { service, request, getClient } = await setup({});
    try {
      await expect(service.initialize({ workspacePath: WORKSPACE_PATH })).resolves.toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(getClient).toHaveBeenCalled();
      expect(policyCalls(request)).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  it("灰度关闭时读取快照但不发策略请求", async () => {
    const { service, request, resolveConfig } = await setup({ enabled: false });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(resolveConfig).toHaveBeenCalledTimes(1);
      expect(policyCalls(request)).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  it("灰度开启时在客户端就绪阶段下发 enabled:true", async () => {
    const { service, request } = await setup({ enabled: true });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      const calls = policyCalls(request);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual({
        workspace: expect.objectContaining({ workspacePath: WORKSPACE_PATH }),
        enabled: true,
        mode: "alwaysOn",
      });
    } finally {
      service.disposeAll();
    }
  });

  it("onDemand 与 alwaysOn 同为开启，且 mode 原样随策略下发", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("onDemand", "remote"),
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request)).toHaveLength(1);
      expect(policyCalls(request)[0]?.[1]).toMatchObject({ enabled: true, mode: "onDemand" });
    } finally {
      service.disposeAll();
    }
  });

  it("alwaysOn 也带 mode（launch.md「How the mode travels」：mode 与布尔同行）", async () => {
    const { service, request } = await setup({ enabled: true });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request)[0]?.[1]).toMatchObject({ enabled: true, mode: "alwaysOn" });
    } finally {
      service.disposeAll();
    }
  });

  it("resolver 抛错时按关闭处理，不发策略也不阻断就绪", async () => {
    const { service, request } = await setup({
      configResolver: async () => {
        throw new Error("client configs unavailable");
      },
    });
    try {
      await expect(service.initialize({ workspacePath: WORKSPACE_PATH })).resolves.toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(policyCalls(request)).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  it("resolver 返回 undefined 时按关闭处理", async () => {
    const { service, request } = await setup({ configResolver: async () => undefined });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request)).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  it("旧 CLI method-not-found（-32601）降级忽略，不阻塞客户端就绪", async () => {
    const { service, request } = await setup({
      enabled: true,
      policyResponse: () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    });
    try {
      await expect(service.initialize({ workspacePath: WORKSPACE_PATH })).resolves.toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(policyCalls(request)).toHaveLength(1);
    } finally {
      service.disposeAll();
    }
  });

  it("策略同步超时等非 -32601 错误只记 warn，不阻断客户端就绪", async () => {
    const { service, request } = await setup({
      enabled: true,
      policyResponse: () => {
        throw new Error("request timed out");
      },
    });
    try {
      await expect(service.initialize({ workspacePath: WORKSPACE_PATH })).resolves.toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(policyCalls(request)).toHaveLength(1);
    } finally {
      service.disposeAll();
    }
  });

  it.each([
    { remoteSessionId: "remote-session" },
    {
      workspaceIdentity: buildRemoteWorkspaceIdentity(WORKSPACE_PATH, {
        kind: "ssh",
        host: "test",
        username: "dev",
      }),
    },
  ])("远程 workspace 开启时同样下发策略：%j", async (target) => {
    const { service, request } = await setup({ enabled: true });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH, ...target });
      expect(policyCalls(request)).toHaveLength(1);
    } finally {
      service.disposeAll();
    }
  });
});

describe("session create / resume / v4 createSession 的 flag（DWG-02）", () => {
  it("灰度开启时三条创建路径都带 dynamicWorkflowEnabled:true", async () => {
    const { service, request, resolveConfig } = await setup({ enabled: true });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-create" });
      await service.resumeSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-resume" });
      await service.sendConversationCommandV4({
        workspacePath: WORKSPACE_PATH,
        envelope: v4CreateSessionEnvelope("cmd-dwf-on"),
      });

      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "alwaysOn",
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionResume)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "alwaysOn",
      });
      expect(paramsOf(request, V4_METHODS.command)[0]).toMatchObject({
        payload: { dynamicWorkflowEnabled: true, dynamicWorkflowMode: "alwaysOn" },
      });
      // 判定随 client 生命周期固定：三次创建复用同一次读取，不是每次建会话打一次远端。
      expect(resolveConfig).toHaveBeenCalledTimes(1);
    } finally {
      service.disposeAll();
    }
  });

  // launch.md「On demand: activation」「How the mode travels」：onDemand 原样到达三条创建路径。
  it("onDemand 时三条创建路径都带 dynamicWorkflowMode:onDemand", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("onDemand", "remote"),
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-create" });
      await service.resumeSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-resume" });
      await service.sendConversationCommandV4({
        workspacePath: WORKSPACE_PATH,
        envelope: v4CreateSessionEnvelope("cmd-dwf-on-demand"),
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionResume)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(paramsOf(request, V4_METHODS.command)[0]).toMatchObject({
        payload: { dynamicWorkflowEnabled: true, dynamicWorkflowMode: "onDemand" },
      });
    } finally {
      service.disposeAll();
    }
  });

  it("灰度关闭时三条创建路径都不写该字段", async () => {
    const { service, request } = await setup({ enabled: false });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-create" });
      await service.resumeSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-resume" });
      await service.sendConversationCommandV4({
        workspacePath: WORKSPACE_PATH,
        envelope: v4CreateSessionEnvelope("cmd-dwf-off"),
      });

      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowEnabled",
      );
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowMode",
      );
      expect(paramsOf(request, zcodeProtocolMethods.sessionResume)[0]).not.toHaveProperty(
        "dynamicWorkflowEnabled",
      );
      expect(
        (paramsOf(request, V4_METHODS.command)[0] as { payload: Record<string, unknown> }).payload,
      ).not.toHaveProperty("dynamicWorkflowEnabled");
      expect(
        (paramsOf(request, V4_METHODS.command)[0] as { payload: Record<string, unknown> }).payload,
      ).not.toHaveProperty("dynamicWorkflowMode");
    } finally {
      service.disposeAll();
    }
  });

  it("未装配 resolver 时同样不写字段（fail-closed）", async () => {
    const { service, request } = await setup({});
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-create" });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowEnabled",
      );
    } finally {
      service.disposeAll();
    }
  });

  it("远程 workspace 开启时创建路径照样带 flag", async () => {
    const { service, request } = await setup({ enabled: true });
    const workspaceIdentity = buildRemoteWorkspaceIdentity(WORKSPACE_PATH, {
      kind: "ssh",
      host: "test",
      username: "dev",
    });
    try {
      await service.createSession({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity,
        sessionId: "s-remote",
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
      });
    } finally {
      service.disposeAll();
    }
  });

  it("旧 CLI 的 strict schema 拒绝该字段时省略后重试成功", async () => {
    const { service, request } = await setup({ enabled: true });
    try {
      let firstCreateSeen = false;
      request.mockImplementation(async (method: string, requestParams?: unknown) => {
        if (method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy) {
          return requestParams;
        }
        if (method === zcodeProtocolMethods.sessionCreate) {
          if (!firstCreateSeen) {
            firstCreateSeen = true;
            throw Object.assign(new Error("Invalid params"), {
              code: -32602,
              data: {
                message: JSON.stringify([
                  { code: "unrecognized_keys", keys: ["dynamicWorkflowEnabled"], path: [] },
                ]),
              },
            });
          }
          return sessionSnapshot("session-created");
        }
        throw new Error(`Unexpected method ${method}`);
      });

      await expect(
        service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-compat" }),
      ).resolves.toMatchObject({ session: { sessionId: "session-created" } });
      const creates = paramsOf(request, zcodeProtocolMethods.sessionCreate);
      expect(creates).toHaveLength(2);
      expect(creates[0]).toMatchObject({ dynamicWorkflowEnabled: true });
      expect(creates[1]).not.toHaveProperty("dynamicWorkflowEnabled");
      // 布尔被省略时 mode 也不能单独出现：对 CLI 没有意义，且旧 CLI 的 strict schema 同样不认。
      expect(creates[1]).not.toHaveProperty("dynamicWorkflowMode");
    } finally {
      service.disposeAll();
    }
  });

  // launch.md「How the mode travels」：只认布尔、不认 mode 的 CLI（本规则之前的版本）——省略 mode
  // 重试，布尔照带，会话按 alwaysOn 行事。
  it("旧 CLI 只拒绝 dynamicWorkflowMode 时省略它重试，布尔保留", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("onDemand", "remote"),
    });
    try {
      let firstCreateSeen = false;
      request.mockImplementation(async (method: string, requestParams?: unknown) => {
        if (method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy) {
          return requestParams;
        }
        if (method === zcodeProtocolMethods.sessionCreate) {
          if (!firstCreateSeen) {
            firstCreateSeen = true;
            throw Object.assign(new Error("Invalid params"), {
              code: -32602,
              data: {
                message: JSON.stringify([
                  { code: "unrecognized_keys", keys: ["dynamicWorkflowMode"], path: [] },
                ]),
              },
            });
          }
          return sessionSnapshot("session-created");
        }
        throw new Error(`Unexpected method ${method}`);
      });

      await expect(
        service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-compat-mode" }),
      ).resolves.toMatchObject({ session: { sessionId: "session-created" } });
      const creates = paramsOf(request, zcodeProtocolMethods.sessionCreate);
      expect(creates).toHaveLength(2);
      expect(creates[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(creates[1]).toMatchObject({ dynamicWorkflowEnabled: true });
      expect(creates[1]).not.toHaveProperty("dynamicWorkflowMode");
    } finally {
      service.disposeAll();
    }
  });
});

// DWG-20（launch.md「The user's choice」）：Host 只闩服务端的「提供」，用户选择每次使用时重新应用；
// 选择变化后按 workspace 串行重发策略，只在生效模式真的变了时才发。
describe("用户选择（DWG-20）", () => {
  it("闩住的提供 + 每次读取的用户选择：两次建会话之间改选择，第二次就带新模式", async () => {
    let choice: DynamicWorkflowMode | undefined = "onDemand";
    const { service, request, resolveConfig } = await setup({
      enabled: true,
      userModeResolver: async () => choice,
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-1" });
      choice = "alwaysOn";
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-2" });
      const creates = paramsOf(request, zcodeProtocolMethods.sessionCreate);
      expect(creates[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(creates[1]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "alwaysOn",
      });
      expect(resolveConfig).toHaveBeenCalledTimes(1);
    } finally {
      service.disposeAll();
    }
  });

  it("用户选择关闭：客户端就绪不发策略，建会话不带工作流字段", async () => {
    const { service, request } = await setup({
      enabled: true,
      userModeResolver: async () => "disabled",
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-off" });
      expect(policyCalls(request)).toHaveLength(0);
      const create = paramsOf(request, zcodeProtocolMethods.sessionCreate)[0] as Record<
        string,
        unknown
      >;
      expect(create).not.toHaveProperty("dynamicWorkflowEnabled", true);
      expect(create).not.toHaveProperty("dynamicWorkflowMode");
    } finally {
      service.disposeAll();
    }
  });

  it("服务端未提供时用户选择不生效", async () => {
    const { service, request } = await setup({
      enabled: false,
      userModeResolver: async () => "alwaysOn",
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-gated" });
      expect(policyCalls(request)).toHaveLength(0);
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowMode",
      );
    } finally {
      service.disposeAll();
    }
  });

  it("syncDynamicWorkflowUserMode 只在生效模式变化时重发策略，关闭时发 enabled:false", async () => {
    let choice: DynamicWorkflowMode | undefined;
    const { service, request } = await setup({
      enabled: true,
      userModeResolver: async () => choice,
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request).map(([, value]) => value)).toEqual([
        expect.objectContaining({ enabled: true, mode: "alwaysOn" }),
      ]);

      await service.syncDynamicWorkflowUserMode({});
      expect(policyCalls(request)).toHaveLength(1);

      choice = "disabled";
      await service.syncDynamicWorkflowUserMode({ mode: "disabled" });
      choice = "onDemand";
      await service.syncDynamicWorkflowUserMode({ mode: "onDemand" });
      const sent = policyCalls(request).map(([, value]) => value as Record<string, unknown>);
      expect(sent).toHaveLength(3);
      expect(sent[1]).toEqual({
        workspace: expect.objectContaining({ workspacePath: WORKSPACE_PATH }),
        enabled: false,
      });
      expect(sent[2]).toMatchObject({ enabled: true, mode: "onDemand" });
    } finally {
      service.disposeAll();
    }
  });

  it("同一 workspace 的策略同步串行：慢请求返回前不发下一条，最后落地的是最新选择", async () => {
    let choice: DynamicWorkflowMode | undefined;
    let releaseFirst: (() => void) | undefined;
    let policyRequests = 0;
    const { service, request } = await setup({
      enabled: true,
      userModeResolver: async () => choice,
      policyResponse: async (value) => {
        policyRequests += 1;
        if (policyRequests === 2) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return value;
      },
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      choice = "disabled";
      const slow = service.syncDynamicWorkflowUserMode({ mode: "disabled" });
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      choice = "onDemand";
      const fast = service.syncDynamicWorkflowUserMode({ mode: "onDemand" });
      // 第二次同步排在第一次后面：第一条未返回时不会发出第三条请求。
      expect(policyCalls(request)).toHaveLength(2);
      releaseFirst?.();
      await Promise.all([slow, fast]);
      const sent = policyCalls(request).map(([, value]) => value as Record<string, unknown>);
      expect(sent).toHaveLength(3);
      expect(sent[2]).toMatchObject({ enabled: true, mode: "onDemand" });
    } finally {
      service.disposeAll();
    }
  });

  it("本机设置权威：同步时把读到的选择交给转发回调（desktop 再推给远程 Host）", async () => {
    const forwardUserMode = vi.fn();
    const { service } = await setup({
      enabled: true,
      userModeResolver: async () => "onDemand",
      forwardUserMode,
    });
    try {
      // 传入值只是信号：本机有设置权威时以设置文件为准。
      await service.syncDynamicWorkflowUserMode({ mode: "disabled" });
      expect(forwardUserMode).toHaveBeenCalledWith("onDemand");
    } finally {
      service.disposeAll();
    }
  });
});

// DWG-21：desktop-attached remote Host 没有本机设置权威，用 desktop 推来的选择。
describe("远程 Host 的用户选择（DWG-21）", () => {
  it("没有本机 resolver 时应用最近一次推送的选择", async () => {
    const { service, request } = await setup({ enabled: true });
    try {
      await service.syncDynamicWorkflowUserMode({ mode: "onDemand" });
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-pushed" });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      await service.syncDynamicWorkflowUserMode({});
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-follow" });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[1]).toMatchObject({
        dynamicWorkflowMode: "alwaysOn",
      });
    } finally {
      service.disposeAll();
    }
  });
});
