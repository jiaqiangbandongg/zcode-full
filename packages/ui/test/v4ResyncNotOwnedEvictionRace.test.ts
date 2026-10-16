// fault.subscription.notOwned 线上竞态（zcode-logs-full-20260730-204321 三起事件）的机制层还原
// 与修复验证。
//
// 竞态时序（renderer ⇄ host 为异步链路，远程 SSH workspace 下窗口达数百 ms）：
//
//   renderer(store/transport)          host(connectionScope)             CLI(base)
//   ──────────────────────────         ─────────────────────             ─────────
//   connect() → subscribe ────────────▶ remember(S1) ◀──────────────────  ACK S1
//   [S1 live]
//   connect() 换代重订阅 ──subscribe(S2) 在途──▶ …
//   S1 online 帧断档
//     → resync(S1) 通过本地
//       ownership 检查，RPC 在途 ─────▶ …
//   sendCommand ──────────────────────▶ 校验通过 ─────────────────────▶  成功
//                                       remember(S2)：同 ownershipKey
//                                       静默驱逐 S1（不发 unsubscribe、
//                                       无 runtime restart）◀──────────  ACK S2
//   [S2 live]
//   迟到的 resync(S1) 抵达 ───────────▶ findBySubscription 找不到 S1
//                                       → 拒绝 fault.subscription.notOwned
//
// 修复前 store 会把这次迟到失败写成 status="error" 且无自动重连（会话永久卡死，需手动重连）。
// 修复后的正确行为分两层，对应本文件的两个正向用例：
//   1. connect() 换代成功时丢弃 await 窗口内创建的旧订阅 recovery——迟到的 notOwned
//      属于已换代丢弃的恢复流，静默忽略，S2 保持 live；
//   2. 若 notOwned 命中的是"仍属当前订阅"的 recovery（如错位 unsubscribe 造成的
//      ownership 分歧），store 携当前水位 fresh subscribe 自愈，不落 error。
import { Emitter } from "@zcode/rpc";
import type { LocalTtftFacts } from "@zcode/shared";
import type {
  ConversationTopicFrame,
  ConversationTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  type IZCodeAgentService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";

const TOPIC = "conversation/s1";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── CLI base mock：只提供 conversation 面所需的最小行为 ──
function setupBase() {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const localTtftFacts = new Emitter<LocalTtftFacts>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  const mocks = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => ({
      ack: {
        subscriptionId: nextId(params),
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume" as const,
        logEpoch: "epoch-1",
      },
    })),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    // transport.onFrame 会顺带挂载本地 TTFT 检查点 emitter（desktop-continuous 本地
    // workspace 才有），base 必须提供该动态 Event，否则 connectionScope 转发时直接抛错。
    onDynamicLocalTtftFacts: vi.fn(() => localTtftFacts.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    setConnectionFlowStateV4: vi.fn(async () => {}),
  };
  return {
    base: mocks as unknown as IZCodeAgentService,
    mocks,
    conversationFrames,
  };
}

// ── RPC 延迟闸门：模拟 renderer→host 链路上的在途请求（远程 SSH 下真实存在的时延）──
function createRpcGate(service: IZCodeAgentService) {
  const holding = new Set<string>();
  const held = new Map<string, Array<() => void>>();
  const proxy = new Proxy(service as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = String(property);
      return (...args: unknown[]) => {
        if (!holding.has(method)) return (value as (...a: unknown[]) => unknown)(...args);
        return new Promise((resolve, reject) => {
          const queue = held.get(method) ?? [];
          queue.push(() => {
            Promise.resolve()
              .then(() => (value as (...a: unknown[]) => unknown)(...args))
              .then(resolve, reject);
          });
          held.set(method, queue);
        });
      };
    },
  }) as unknown as IZCodeAgentService;
  return {
    service: proxy,
    hold(method: string) {
      holding.add(method);
    },
    heldCount(method: string) {
      return held.get(method)?.length ?? 0;
    },
    async release(method: string) {
      holding.delete(method);
      const queue = held.get(method) ?? [];
      held.delete(method);
      for (const run of queue) run();
      await flush();
    },
  };
}

function onlineDeltasWire(
  subscriptionId: string,
  ordinal: number,
  fromSeq: number,
  toSeq: number,
): ConversationTopicWireFrame {
  const frame: ConversationTopicFrame = {
    topic: TOPIC,
    subscriptionId,
    fromSeq,
    toSeq,
    sentAt: 1,
    payload: { kind: "deltas", deltas: [] },
  };
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `logical-${subscriptionId}-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: TOPIC,
    subscriptionId,
    frame,
  };
}

describe("v4 resync notOwned eviction race（真实 store + transport + connectionScope）", () => {
  it("换代 subscribe ACK 静默驱逐旧 ownership 后，迟到 resync 的 notOwned 被静默忽略，S2 保持 live", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    // 1) 首连成功：S1 上线（initial 帧尚未到达，appliedBase=false——与线上远程链路一致）。
    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-1");

    // 2) UI 换代重订阅（真实触发点：retry()、resume initial 断档强 snapshot、
    //    initialFrameStagingOverflow 自动重试等），subscribe(S2) 在 renderer→host 链路上在途。
    gate.hold("subscribeConversationV4");
    const reconnect = store.connect();
    await flush();
    expect(gate.heldCount("subscribeConversationV4")).toBe(1);

    // 3) 竞态窗口内 S1 收到 online delta（initial 缺失 → same-sub recovery）：
    //    resync(S1) 已通过 transport 本地 ownership 检查，RPC 同样在途。
    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-1-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // 3.5) 同窗口 command 照常成功——对应线上日志"resync 失败前 sendCommand 正常"，
    //      证明连接与握手都健康，排除断连/重启因素。
    const ack = await transport.sendCommand(
      createCommandEnvelope({ type: "sendText", payload: { text: "hi" }, sessionId: "s1" }),
    );
    expect(ack.status).toBe("accepted");

    // 4) subscribe(S2) ACK 先抵达 host：remember() 以同 ownershipKey
    //    (conversation, workspace, topic, connectionId) 静默驱逐 S1——
    //    不向 CLI 发 unsubscribe，也没有 runtime restart。
    await gate.release("subscribeConversationV4");
    await reconnect;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-2");
    expect(mocks.unsubscribeConversationV4).not.toHaveBeenCalled();

    // 5) 迟到的 resync(S1) 此刻才抵达 host scope → fault.subscription.notOwned。
    await gate.release("resyncConversationV4");
    await flush();

    // 修复后形态：scope 仍然拒绝（请求未到 CLI），但 store 在换代成功时已丢弃 S1 的
    // recovery，迟到失败被静默忽略——S2 保持 live，不落 error，也不触发多余的重订阅。
    expect(mocks.resyncConversationV4).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-2");
    expect(store.getState().lastError).toBeNull();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);

    offFrame();
  });

  it("错位 unsubscribe 造成 ownership 分歧时，resync notOwned 自动携水位重订阅自愈", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-3",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    await store.connect();
    expect(store.getState().subscriptionId).toBe("sub-conn-3-1");

    // 断档触发 same-sub recovery：resync(S1) 在 renderer→host 链路上在途。
    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-3-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // 错位退订：另一个持有同连接的调用方（重复挂载的 data layer / 旧视图实例）直接向
    // scope 退订 S1。transport 本地 map 不知情——线上日志"unsubscribe → resync notOwned"
    // 序列即此形态。
    await scope.service.unsubscribeConversationV4({
      workspacePath: "/repo",
      subscriptionId: "sub-conn-3-1",
    });

    // 迟到的 resync(S1) 抵达 → notOwned。修复后 store 不落 error，而是携当前水位
    // fresh subscribe（由服务端裁决 resume/snapshot）完成自愈。
    await gate.release("resyncConversationV4");
    await vi.waitFor(() => {
      expect(store.getState().subscriptionId).toBe("sub-conn-3-2");
    });
    expect(store.getState().status).toBe("live");
    expect(store.getState().lastError).toBeNull();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);

    offFrame();
  });

  it("对照：resync(S1) 先于 subscribe(S2) ACK 抵达 host 时不触发 notOwned", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    await store.connect();
    expect(store.getState().subscriptionId).toBe("sub-conn-2-1");

    gate.hold("subscribeConversationV4");
    const reconnect = store.connect();
    await flush();

    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-2-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // 唯一差异：到达顺序对调——resync(S1) 先落地，此刻 scope 仍持有 S1 ownership。
    await gate.release("resyncConversationV4");
    expect(mocks.resyncConversationV4).toHaveBeenCalledTimes(1);
    expect(store.getState().status).not.toBe("error");

    await gate.release("subscribeConversationV4");
    await reconnect;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-2-2");
    expect(store.getState().lastError).toBeNull();

    offFrame();
  });
});
