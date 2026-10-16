import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
  type IZCodeAgentService as IZCodeAgentServiceType,
} from "@zcode/services";
import type {
  AgentLaneResourceSample,
  ZCodeMcpTelemetryEvent,
  ZCodeMcpResourceSample,
  ZCodeToolExecResource,
} from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { registerHostServiceResourceTelemetry } from "../src/host/hostServiceResourceTelemetry.js";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";

// 远端 CLI 自报的运行机信息：main 出口据此覆盖桌面机的硬件维度。
const remoteSample: AgentLaneResourceSample = {
  arch: "x64",
  cpuCores: 1.5,
  cpuPercent: 18.75,
  heapUsedKb: 52_000,
  instanceToken: "remote-instance-01",
  intervalMs: 60_000,
  lane: "chat",
  logicalCpuCount: 8,
  platform: "linux",
  rssKb: 132_000,
  totalMemoryGb: 16,
  uptimeMinutes: 11,
};

const remoteMcpEvent: ZCodeMcpTelemetryEvent = {
  arch: "x64",
  kind: "memory",
  mcpId: "builtin:node_repl",
  mcpInstanceId: "mcp-instance-remote-1",
  mcpIsolation: "workspace",
  mcpSource: "builtin",
  memoryKb: 64_000,
  memoryScope: "process_tree",
  occurredAt: 2_000,
  orphanSuspected: false,
  ownerSessionCount: 1,
  platform: "linux",
  unownedSeconds: 0,
};

/** 远端 workspace 的 service collection：Agent service 是远端 zcode-server 的 RPC 代理。 */
function createRemoteWorkspaceServicesStub() {
  const samples = new Emitter<AgentLaneResourceSample>();
  const toolSamples = new Emitter<ZCodeToolExecResource>();
  const mcpSamples = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpEvents = new Emitter<ZCodeMcpTelemetryEvent>();
  const subscriptions = { added: 0, disposed: 0 };
  const counted = <T>(event: Event<T>): Event<T> => {
    return (listener) => {
      subscriptions.added += 1;
      const registration = event(listener);
      return {
        dispose: () => {
          subscriptions.disposed += 1;
          registration.dispose();
        },
      };
    };
  };
  const agentService = {
    onDynamicProcessResourceSample: vi.fn(() => counted(samples.event)),
    onDynamicToolExecResource: vi.fn(() => counted(toolSamples.event)),
    onDynamicMcpResourceSamples: vi.fn(() => counted(mcpSamples.event)),
    onDynamicMcpTelemetry: vi.fn(() => counted(mcpEvents.event)),
  } as unknown as IZCodeAgentServiceType;
  const services = new ServiceCollection().register(IZCodeAgentService, agentService);
  return { agentService, toolSamples, mcpSamples, mcpEvents, samples, services, subscriptions };
}

describe("registerHostServiceResourceTelemetry", () => {
  it("独立 Server 未声明资源能力时完全跳过订阅，服务连接不受影响", () => {
    const remote = createRemoteWorkspaceServicesStub();
    const getOptional = vi.spyOn(remote.services, "getOptional");
    const postMessage = vi.fn();
    const onError = vi.fn();

    const telemetry = registerHostServiceResourceTelemetry({
      services: remote.services,
      postMessage,
      runtimeSurface: "remote",
      telemetrySupported: false,
      onError,
    });
    remote.samples.fire(remoteSample);
    remote.mcpEvents.fire(remoteMcpEvent);
    telemetry.dispose();
    telemetry.dispose();

    expect(getOptional).not.toHaveBeenCalled();
    expect(remote.subscriptions).toEqual({ added: 0, disposed: 0 });
    expect(postMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("远端 service collection 建立后订阅资源遥测，CLI 样本与 MCP 事件都带 runtime_surface=remote", () => {
    const remote = createRemoteWorkspaceServicesStub();
    const postMessage = vi.fn();

    const telemetry = registerHostServiceResourceTelemetry({
      services: remote.services,
      postMessage,
      runtimeSurface: "remote",
      telemetrySupported: true,
      environmentKey: "remote-environment-01",
    });

    remote.samples.fire(remoteSample);
    remote.mcpEvents.fire(remoteMcpEvent);
    telemetry.dispose();

    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: "remote",
        environmentKey: "remote-environment-01",
        sample: remoteSample,
      },
      {
        type: HostResponseTypes.McpTelemetry,
        runtimeSurface: "remote",
        event: remoteMcpEvent,
      },
    ]);
  });

  it("MCP 资源数组沿远端 collection 转发并随连接释放", () => {
    const remote = createRemoteWorkspaceServicesStub();
    const postMessage = vi.fn();
    const telemetry = registerHostServiceResourceTelemetry({
      services: remote.services,
      postMessage,
      runtimeSurface: "remote",
      environmentKey: "remote-environment-01",
    });
    const samples: ZCodeMcpResourceSample[] = [
      {
        mcpId: "builtin:node_repl",
        instanceToken: "cli-instance-01",
        sampledAt: 300000,
        intervalMs: 300000,
        processCount: 1,
        rssKbTotal: 100,
        rssKbMaxProcess: 100,
        cpuTimeMsDelta: 0,
        uptimeMinutes: 5,
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        totalMemoryGb: 32,
      },
    ];
    remote.mcpSamples.fire(samples);
    telemetry.dispose();
    remote.mcpSamples.fire(samples);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "mcp-resource-samples",
      runtimeSurface: "remote",
      environmentKey: "remote-environment-01",
      samples,
    });
  });

  it("远端连接断开时订阅随之释放，不泄漏监听器", () => {
    const remote = createRemoteWorkspaceServicesStub();
    const postMessage = vi.fn();

    const telemetry = registerHostServiceResourceTelemetry({
      services: remote.services,
      postMessage,
      runtimeSurface: "remote",
    });
    expect(remote.subscriptions).toEqual({ added: 4, disposed: 0 });

    telemetry.dispose();
    // 重复 dispose 只允许幂等，不能二次释放同一个订阅。
    telemetry.dispose();
    remote.samples.fire(remoteSample);
    remote.mcpEvents.fire(remoteMcpEvent);

    expect(remote.subscriptions).toEqual({ added: 4, disposed: 4 });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("远端 services 缺少 Agent service 时不订阅也不抛错", () => {
    const postMessage = vi.fn();

    const telemetry = registerHostServiceResourceTelemetry({
      services: new ServiceCollection(),
      postMessage,
      runtimeSurface: "remote",
    });

    expect(() => telemetry.dispose()).not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("单个订阅失败时释放已建立的订阅并交给 onError，不影响远程连接结果", () => {
    const samples = new Emitter<AgentLaneResourceSample>();
    let samplesDisposed = 0;
    const agentService = {
      onDynamicProcessResourceSample:
        () => (listener: (sample: AgentLaneResourceSample) => void) => {
          const registration = samples.event(listener);
          return {
            dispose: () => {
              samplesDisposed += 1;
              registration.dispose();
            },
          };
        },
      onDynamicMcpTelemetry: () => {
        throw new Error("remote channel closed");
      },
    } as unknown as IZCodeAgentServiceType;
    const services = new ServiceCollection().register(IZCodeAgentService, agentService);
    const postMessage = vi.fn();
    const onError = vi.fn();

    const telemetry = registerHostServiceResourceTelemetry({
      services,
      postMessage,
      runtimeSurface: "remote",
      onError,
    });
    samples.fire(remoteSample);

    expect(samplesDisposed).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
    expect(() => telemetry.dispose()).not.toThrow();
  });

  it("手机远控 attachment 建立后没有资源遥测订阅", () => {
    const remote = createRemoteWorkspaceServicesStub();
    const postMessage = vi.fn();
    const telemetry = registerHostServiceResourceTelemetry({
      services: remote.services,
      postMessage,
      runtimeSurface: "remote",
    });
    const subscriptionsAfterConnect = { ...remote.subscriptions };
    const attachmentSamples: AgentLaneResourceSample[] = [];
    const closeListeners: (() => void)[] = [];
    // attachment 与生产一致：只在已就绪的 collection 上再开一个 Agent connection scope。
    // 等价依据：生产的 expose 是 host/index.ts 的 exposeServicesOnMessagePort，它同样
    // `createZCodeAgentConnectionScope(agentService, { connectionId, clientMode })` 且**不传 role**，
    // 因此 attachment 一律是 terminal-client；这里只把那一步搬进测试，registry 与 scope 都是真实实现。
    // 若哪天生产给 attachment 传了 role，本测试不会自动变红——那一层的边界断言在
    // packages/services/test/zcodeAgentConnectionScope.test.ts。
    const attachmentRegistry = createWindowHostAttachmentRegistry<
      ServiceCollection,
      { once(event: "close", listener: () => void): unknown }
    >({
      resolveScope: () => ({ services: remote.services, generation: 1 }),
      expose: ({ services, clientMode }) => {
        const scope = createZCodeAgentConnectionScope(services.get(IZCodeAgentService), {
          connectionId: `host-rpc-${clientMode}`,
          clientMode,
        });
        const subscription: IDisposable = scope.service.onDynamicProcessResourceSample()((sample) =>
          attachmentSamples.push(sample),
        );
        return {
          dispose: () => {
            subscription.dispose();
            void scope.dispose();
          },
        };
      },
    });

    attachmentRegistry.attach({
      requestId: "mobile-request-1",
      attachmentId: "mobile-attachment-1",
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/home/dev/project",
        workspaceIdentity: "ssh://dev@remote-host/home/dev/project",
      },
      port: { once: (_event, listener) => closeListeners.push(listener) },
    });
    remote.samples.fire(remoteSample);

    // 手机远控只消费可恢复对话事实：attachment 侧拿不到资源样本，也没有新增底层订阅。
    expect(attachmentSamples).toEqual([]);
    expect(remote.subscriptions).toEqual(subscriptionsAfterConnect);
    expect(postMessage).toHaveBeenCalledOnce();

    attachmentRegistry.dispose();
    telemetry.dispose();
  });
});

it("Bash 完成事实随 collection 注册与释放，保留 runtime surface", () => {
  const remote = createRemoteWorkspaceServicesStub();
  const postMessage = vi.fn();
  const handle = registerHostServiceResourceTelemetry({
    services: remote.services,
    postMessage,
    runtimeSurface: "local",
  });
  const sample: ZCodeToolExecResource = {
    platform: "win32",
    toolName: "bash",
    durationMs: 40000,
    exitKind: "completed",
    sampleCount: 0,
    cliRssKb: 1024,
    systemFreeMemoryKb: 2048,
  };
  remote.toolSamples.fire(sample);
  handle.dispose();
  remote.toolSamples.fire(sample);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "tool-exec-resource",
    runtimeSurface: "local",
    sample,
  });
});
