import { expect, it, vi } from "vitest";
import { Emitter, ProxyChannel, type IServerChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IProjectService,
  type IZCodeAgentService,
  type ZCodeAgentRuntimeLifecycleEvent,
  type ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import {
  sessionsIndexTopic,
  type SessionsIndexTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { bindRemoteProjectIdentities } from "../../services/src/project/index.js";
import {
  SourceServerWorkspaceIdentityMapper,
  SourceServerWorkspaceIdentityChannelServer,
} from "../../services/src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
import { createWindowHostSessionsIndexObserver } from "../src/host/windowHostSessionsIndexObserver.js";

it.each([false, true])(
  "empty remote project receives first permission without restart (runtime already running=%s)",
  async (initiallyRunning) => {
    const workspacePath = "/repo";
    const stable = "remote:server:source:/repo";
    const canonical = "remote:ssh:example.test:22:dev:/repo";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
    const emitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
    const emitter = (identity: string) => {
      let value = emitters.get(identity);
      if (!value) {
        value = new Emitter();
        emitters.set(identity, value);
      }
      return value;
    };
    let running = initiallyRunning;
    const subscribe = vi.fn(async (target: ZCodeAgentWorkspaceTarget) => {
      if (!running || target.workspaceIdentity !== canonical)
        throw Object.assign(new Error("runtime unavailable"), {
          code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
        });
      const key = target.workspaceIdentity ?? target.workspacePath;
      const topic = sessionsIndexTopic(key);
      emitter(key).fire({
        wireVersion: 3,
        kind: "complete",
        deliveryKind: "initial",
        logicalFrameId: "first",
        logicalFrameOrdinal: 1,
        topic,
        subscriptionId: "subscription",
        frame: {
          topic,
          subscriptionId: "subscription",
          fromSeq: 0,
          toSeq: 1,
          sentAt: 1,
          payload: {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId: key,
              logEpoch: "epoch",
              sessions: [
                {
                  sessionId: "first-task",
                  workspaceId: key,
                  title: "First task",
                  phase: "running",
                  sessionEnded: false,
                  hasBackgroundWork: false,
                  lastActivityAt: 2,
                  createdAt: 1,
                  pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
                },
              ],
            },
          },
        },
      });
      return {
        ack: { subscriptionId: "subscription", mode: "snapshot" as const, logEpoch: "epoch" },
      };
    });
    const inner = {
      onDynamicSessionsIndexFrame: (target: ZCodeAgentWorkspaceTarget) =>
        emitter(target.workspaceIdentity ?? target.workspacePath).event,
      onAgentRuntimeLifecycle: lifecycle.event,
      subscribeSessionsIndexV4: subscribe,
      unsubscribeSessionsIndexV4: async () => undefined,
      resyncSessionsIndexV4: vi.fn(),
    };
    let channel!: IServerChannel<string>;
    new SourceServerWorkspaceIdentityChannelServer(
      {
        registerChannel: (_name, registered) => {
          channel = registered;
        },
      },
      mapper,
    ).registerChannel(ServiceChannels.ZCodeAgent, ProxyChannel.fromService(inner));
    const agent = ProxyChannel.toService<IZCodeAgentService>({
      call: (command, args) => channel.call("controller", command, args),
      listen: (event, args) => channel.listen("controller", event, args),
    });
    // 真实项目树适配器是订阅前的身份准备边界；旧实现忽略没有 task 的 root。
    const service = bindRemoteProjectIdentities(
      {
        readTree: async () => ({ projects: [{ roots: [{ rootPath: workspacePath }] }], tasks: [] }),
      } as unknown as IProjectService,
      async () => {
        mapper.register({ stableIdentity: stable, canonicalIdentity: canonical });
        return stable;
      },
    );
    await service.readTree();
    const changes = vi.fn();
    const observer = createWindowHostSessionsIndexObserver({
      agentService: agent,
      target: { workspacePath, workspaceIdentity: stable },
      onSessionsChange: changes,
    });
    try {
      await observer.start();
      // 首次打开仍会调用相同 resolver；该步骤不能挽救已经绑定到错误 emitter 的监听。
      mapper.register({ stableIdentity: stable, canonicalIdentity: canonical });
      if (!initiallyRunning) {
        running = true;
        lifecycle.fire({
          workspaceKey: canonical,
          workspacePath,
          workspaceIdentity: canonical,
          state: "available",
          runtimeIdentity: { workspaceKey: canonical, generation: 1, identity: "runtime" },
        });
      }
      await vi.waitFor(() =>
        expect(changes).toHaveBeenCalledWith([
          expect.objectContaining({
            sessionId: "first-task",
            pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
          }),
        ]),
      );
    } finally {
      observer.dispose();
      lifecycle.dispose();
      for (const value of emitters.values()) value.dispose();
    }
  },
);
