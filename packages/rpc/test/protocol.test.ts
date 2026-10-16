import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { VSBuffer } from "../src/buffer.js";
import {
  ChunkStream,
  createQueuePair,
  MessagePortProtocol,
  ProtocolMessageType,
  type ConnectionFlowControl,
  type ISocket,
  type MessagePortLike,
  type MessagePortPayload,
} from "../src/protocol.js";
import { PersistentProtocol } from "../src/persistent-protocol.js";
import { Event, Emitter } from "../src/foundation.js";

describe("ChunkStream", () => {
  it("should accept and read exact chunk", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.fromString("hello"));
    expect(stream.byteLength).toBe(5);
    const result = stream.read(5);
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe("hello");
    expect(stream.byteLength).toBe(0);
  });

  it("should return null when not enough data", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.fromString("hi"));
    expect(stream.read(10)).toBeNull();
    expect(stream.byteLength).toBe(2);
  });

  it("should handle partial reads from a larger chunk", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.fromString("abcdef"));
    const r1 = stream.read(3);
    expect(r1!.toString()).toBe("abc");
    const r2 = stream.read(3);
    expect(r2!.toString()).toBe("def");
  });

  it("should handle reads spanning multiple chunks", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.fromString("ab"));
    stream.acceptChunk(VSBuffer.fromString("cd"));
    stream.acceptChunk(VSBuffer.fromString("ef"));
    const result = stream.read(5);
    expect(result!.toString()).toBe("abcde");
    expect(stream.byteLength).toBe(1);
  });
});

// ── PersistentProtocol 两个补丁（docs/v4-refactor/05 §@zcode/rpc）──

/** 可注入数据的假 socket：write 收集出站帧，emitData 模拟对端来包。 */
class FakeSocket implements ISocket {
  private readonly _onData = new Emitter<VSBuffer>();
  onData = this._onData.event;
  private readonly _onClose = new Emitter<void>();
  onClose = this._onClose.event;
  private readonly _onEnd = new Emitter<void>();
  onEnd = this._onEnd.event;
  readonly written: VSBuffer[] = [];

  write(buffer: VSBuffer): void {
    this.written.push(buffer);
  }
  emitData(buffer: VSBuffer): void {
    this._onData.fire(buffer);
  }
  end(): void {}
  async drain(): Promise<void> {}
  dispose(): void {}
}

/** 构造对端 ACK 帧（type=Ack, 13 字节 header, 无 payload）。 */
function ackFrame(ack: number): VSBuffer {
  const buffer = VSBuffer.alloc(13);
  buffer.writeUInt8(ProtocolMessageType.Ack, 0);
  buffer.writeUInt32BE(0, 1);
  buffer.writeUInt32BE(ack, 5);
  buffer.writeUInt32BE(0, 9);
  return buffer;
}

function lastWrittenType(socket: FakeSocket): ProtocolMessageType {
  const frame = socket.written[socket.written.length - 1]!;
  return frame.readUInt8(0) as ProtocolMessageType;
}

describe("PersistentProtocol 拥塞信号（补丁 1）", () => {
  it("结构上满足公共只读 ConnectionFlowControl", () => {
    const socket = new FakeSocket();
    const protocol: ConnectionFlowControl = new PersistentProtocol(socket);

    expect(protocol.unacknowledgedBytes).toBe(0);
    expect(protocol.onSaturated).toBeTypeOf("function");
    expect(protocol.onDrained).toBeTypeOf("function");
    (protocol as PersistentProtocol).dispose();
  });

  it("unacknowledgedBytes 随 send 增长、随 ACK 回落", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket);
    protocol.send(VSBuffer.fromString("aaaa"));
    protocol.send(VSBuffer.fromString("bb"));
    expect(protocol.unacknowledgedBytes).toBe(6);
    // 对端确认到第 1 条。
    socket.emitData(ackFrame(1));
    expect(protocol.unacknowledgedBytes).toBe(2);
    socket.emitData(ackFrame(2));
    expect(protocol.unacknowledgedBytes).toBe(0);
    protocol.dispose();
  });

  it("越过高水位 onSaturated（边沿触发），回落低水位 onDrained", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, {
      saturationHighWaterMarkBytes: 10,
      saturationLowWaterMarkBytes: 4,
    });
    let saturatedCount = 0;
    let drainedCount = 0;
    protocol.onSaturated(() => saturatedCount++);
    protocol.onDrained(() => drainedCount++);

    protocol.send(VSBuffer.fromString("12345678")); // 8B，未过水位
    expect(saturatedCount).toBe(0);
    protocol.send(VSBuffer.fromString("1234")); // 12B，越过高水位
    expect(saturatedCount).toBe(1);
    protocol.send(VSBuffer.fromString("x")); // 持续饱和不重复通知
    expect(saturatedCount).toBe(1);

    socket.emitData(ackFrame(1)); // 剩 5B，仍高于低水位
    expect(drainedCount).toBe(0);
    socket.emitData(ackFrame(2)); // 剩 1B ≤ 4 → drained
    expect(drainedCount).toBe(1);
    protocol.dispose();
  });
});

describe("PersistentProtocol 重放缓冲有界（补丁 2）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("未 ACK 字节越过上限 → 发 Disconnect 并 onClose（客户端走 subscribe(base)）", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, {
      replayBufferMaxBytes: 10,
    });
    let closed = 0;
    protocol.onClose(() => closed++);

    protocol.send(VSBuffer.fromString("12345678"));
    expect(closed).toBe(0);
    protocol.send(VSBuffer.fromString("1234")); // 12B > 10 → 放弃会话
    expect(closed).toBe(1);
    expect(lastWrittenType(socket)).toBe(ProtocolMessageType.Disconnect);

    protocol.send(VSBuffer.fromString("more")); // 已放弃，不重复触发
    expect(closed).toBe(1);
    protocol.dispose();
  });

  it("最老未 ACK 消息超过宽限窗 → 放弃会话", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, {
      replayBufferGraceMs: 30_000,
    });
    let closed = 0;
    protocol.onClose(() => closed++);

    protocol.send(VSBuffer.fromString("hello"));
    vi.advanceTimersByTime(20_000); // 首次 ackCheck：年龄 20s < 30s
    expect(closed).toBe(0);
    vi.advanceTimersByTime(20_000); // 第二次：年龄 40s > 30s → 放弃
    expect(closed).toBe(1);
    protocol.dispose();
  });

  it("及时 ACK 时宽限窗不触发", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, {
      replayBufferGraceMs: 30_000,
    });
    let closed = 0;
    protocol.onClose(() => closed++);

    protocol.send(VSBuffer.fromString("hello"));
    vi.advanceTimersByTime(10_000);
    socket.emitData(ackFrame(1)); // 队列清空
    vi.advanceTimersByTime(60_000);
    expect(closed).toBe(0);
    protocol.dispose();
  });
});

describe("createQueuePair", () => {
  it("should deliver messages between protocol pair", async () => {
    const [a, b] = createQueuePair();

    const messagePromise = Event.toPromise(b.onMessage);
    a.send(VSBuffer.fromString("hello from A"));
    const received = await messagePromise;
    expect(received.toString()).toBe("hello from A");
  });

  it("should work bidirectionally", async () => {
    const [a, b] = createQueuePair();

    const fromA = Event.toPromise(b.onMessage);
    const fromB = Event.toPromise(a.onMessage);

    a.send(VSBuffer.fromString("to B"));
    b.send(VSBuffer.fromString("to A"));

    expect((await fromA).toString()).toBe("to B");
    expect((await fromB).toString()).toBe("to A");
  });
});

class FakeMessagePort implements MessagePortLike {
  private readonly listeners = new Set<(event: { data: MessagePortPayload }) => void>();
  peer?: FakeMessagePort;
  readonly posted: unknown[] = [];

  addEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(message: MessagePortPayload): void {
    this.posted.push(message);
    this.peer?.emit(message);
  }

  emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data: data as MessagePortPayload });
    }
  }

  start(): void {}
  close(): void {}
}

describe("MessagePortProtocol connection flow sideband", () => {
  it("consumes strict control objects before Channel binary delivery", () => {
    const leftPort = new FakeMessagePort();
    const rightPort = new FakeMessagePort();
    leftPort.peer = rightPort;
    rightPort.peer = leftPort;
    const left = new MessagePortProtocol(leftPort);
    const right = new MessagePortProtocol(rightPort);
    const binary: string[] = [];
    const flow: string[] = [];
    right.onMessage((message) => binary.push(message.toString()));
    const flowProtocol = right as MessagePortProtocol & {
      onFlowState(listener: (state: string) => void): { dispose(): void };
    };
    flowProtocol.onFlowState((state) => flow.push(state));

    left.send(VSBuffer.fromString("rpc-binary"));
    (
      left as MessagePortProtocol & {
        sendFlowState(state: "saturated" | "drained"): void;
      }
    ).sendFlowState("saturated");
    rightPort.emit({ __zcodeRpcControl: "connection-flow-v1", state: "forged" });

    expect(binary).toEqual(["rpc-binary"]);
    expect(flow).toEqual(["saturated"]);
    expect(leftPort.posted).toContainEqual({
      __zcodeRpcControl: "connection-flow-v1",
      state: "saturated",
    });
    left.disconnect();
    right.disconnect();
  });
});
