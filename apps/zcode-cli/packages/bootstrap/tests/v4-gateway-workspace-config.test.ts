// ConversationV4Gateway 的 workspace-config 集成测试（M5 删波次 2）：
//   1. subscribeWorkspaceConfig：宿主钩子种子 → snapshot 帧（配置目录 + slash 目录）
//   2. publishWorkspaceConfig → 订阅者收到 config.updated 增量帧；同值发布 conflated 不产帧
//   3. 订阅先于任何发布且宿主无钩子 → 空目录 snapshot（不炸）
//   4. unsubscribeWorkspaceConfig 后不再收帧
//   5. base 水位续传：同代际 seq 对齐 → resume 且无初始帧
import { describe, expect, it } from "vitest";
import type {
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceConfigTopic } from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/index.js";

const configA: WorkspaceConfigState = {
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "anthropic/haiku-4.5",
      options: [
        {
          value: "anthropic/haiku-4.5",
          name: "Haiku 4.5",
          modelProviderId: "anthropic",
          modelProviderName: "Anthropic",
        },
      ],
    },
  ],
  slashCommands: [{ name: "compact", description: "Compact", source: "builtin" }],
};

const configB: WorkspaceConfigState = {
  ...configA,
  configOptions: [
    {
      ...configA.configOptions[0]!,
      currentValue: "anthropic/opus-4.6",
    },
  ],
};

interface Stub {
  frames: WorkspaceConfigTopicFrame[];
  hostConfig: WorkspaceConfigState | null;
}

function makeGateway(stub: Stub, opts: { withConfigHook: boolean } = { withConfigHook: true }) {
  return new ConversationV4Gateway(
    {
      sessionExists: () => false,
      emitWireFrame: (wire) => {
        if (wire.kind === "complete" && wire.topic.startsWith("workspace-config/")) {
          stub.frames.push(wire.frame as WorkspaceConfigTopicFrame);
        }
      },
      executeCommand: async () => undefined,
      ...(opts.withConfigHook ? { getWorkspaceConfig: async () => stub.hostConfig } : {}),
    },
    { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-wc" },
  );
}

async function subscribe(gateway: ConversationV4Gateway, base?: { logEpoch: string; seq: number }) {
  return gateway.subscribeWorkspaceConfig({
    topic: workspaceConfigTopic("ws-1"),
    connectionId: "conn-1",
    clientMode: "desktop-continuous",
    ...(base ? { base } : {}),
  });
}

describe("v4 gateway workspace-config topic", () => {
  it("saturated mobile config subscriber does not block desktop and drains only itself", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    const desktop = await gateway.subscribeWorkspaceConfig({
      topic: workspaceConfigTopic("ws-1"),
      connectionId: "desktop-config",
      clientMode: "desktop-continuous",
    });
    const mobile = await gateway.subscribeWorkspaceConfig({
      topic: workspaceConfigTopic("ws-1"),
      connectionId: "mobile-config",
      clientMode: "web-remote-replayable",
    });

    gateway.setConnectionFlowState({ connectionId: "mobile-config", state: "saturated" });
    gateway.publishWorkspaceConfig("ws-1", configB);
    expect(stub.frames.map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
    ]);

    gateway.setConnectionFlowState({ connectionId: "mobile-config", state: "drained" });
    expect(stub.frames.map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
      mobile.ack.subscriptionId,
    ]);
  });

  it("workspace-config recovery commit 后无新 publish 也会 flush 在途期间最新态", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    const subscribed = await subscribe(gateway);
    const recovery = gateway.resyncReserved({
      topic: workspaceConfigTopic("ws-1"),
      connectionId: "conn-1",
      subscriptionId: subscribed.ack.subscriptionId,
      base: {
        logEpoch: subscribed.ack.logEpoch,
        seq: subscribed.initialFrame?.toSeq ?? 0,
      },
    });

    gateway.publishWorkspaceConfig("ws-1", configB);
    expect(stub.frames).toEqual([]);
    expect(recovery.commit()).toBe(true);
    expect(stub.frames).toHaveLength(1);
    expect(stub.frames[0]).toMatchObject({
      payload: { kind: "deltas", deltas: [{ op: "config.updated", config: configB }] },
    });
  });

  it("initial physical encode 失败会回滚 workspace-config subscription", async () => {
    const stub: Stub = {
      frames: [],
      hostConfig: {
        configOptions: [],
        slashCommands: [
          { name: "oversized", description: "x".repeat(17 * 1024 * 1024), source: "builtin" },
        ],
      },
    };
    const gateway = makeGateway(stub);
    await expect(subscribe(gateway)).rejects.toThrow("proto.frameAssemblyTooLarge");
    const publishers = (
      gateway as unknown as {
        configPublishers: Map<string, { hasSubscribers(): boolean }>;
      }
    ).configPublishers;
    expect(publishers.get("ws-1")?.hasSubscribers()).toBe(false);
  });

  it("订阅时经宿主钩子拉种子并返回待入 outbox 的 snapshot 帧", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    const result = await subscribe(gateway);
    expect(result.ack.mode).toBe("snapshot");
    expect(result.ack.logEpoch).toBe("epoch-wc");
    expect(result.initialFrame?.payload.kind).toBe("snapshot");
    if (result.initialFrame?.payload.kind === "snapshot") {
      expect(result.initialFrame.payload.snapshot.config).toEqual(configA);
      expect(result.initialFrame.payload.snapshot.workspaceId).toBe("ws-1");
    }
  });

  it("publishWorkspaceConfig 推 config.updated 增量帧；同值发布 conflated 不产帧", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    await subscribe(gateway);
    gateway.publishWorkspaceConfig("ws-1", configB);
    expect(stub.frames).toHaveLength(1);
    const frame = stub.frames[0]!;
    expect(frame.payload.kind).toBe("deltas");
    if (frame.payload.kind === "deltas") {
      expect(frame.payload.deltas).toEqual([{ op: "config.updated", config: configB }]);
    }
    // 同值再发布：conflated 去抖，不产新帧。
    gateway.publishWorkspaceConfig("ws-1", configB);
    expect(stub.frames).toHaveLength(1);
  });

  it("宿主无钩子时订阅得到空目录 snapshot（旧宿主兼容）", async () => {
    const stub: Stub = { frames: [], hostConfig: null };
    const gateway = makeGateway(stub, { withConfigHook: false });
    const result = await subscribe(gateway);
    expect(result.initialFrame?.payload.kind).toBe("snapshot");
    if (result.initialFrame?.payload.kind === "snapshot") {
      expect(result.initialFrame.payload.snapshot.config).toEqual({
        configOptions: [],
        slashCommands: [],
      });
    }
  });

  it("unsubscribeWorkspaceConfig 后不再收帧", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    const result = await subscribe(gateway);
    gateway.unsubscribe({
      topic: workspaceConfigTopic("ws-1"),
      subscriptionId: result.ack.subscriptionId,
      connectionId: "conn-1",
    });
    gateway.publishWorkspaceConfig("ws-1", configB);
    expect(stub.frames).toHaveLength(0);
  });

  it("base 水位对齐时 resume 且无初始帧", async () => {
    const stub: Stub = { frames: [], hostConfig: configA };
    const gateway = makeGateway(stub);
    const first = await subscribe(gateway);
    const alignedSeq = first.initialFrame?.toSeq ?? 0;
    const resumed = await subscribe(gateway, {
      logEpoch: first.ack.logEpoch,
      seq: alignedSeq,
    });
    expect(resumed.ack.mode).toBe("resume");
    expect(resumed.initialFrame).toBeNull();
  });
});
