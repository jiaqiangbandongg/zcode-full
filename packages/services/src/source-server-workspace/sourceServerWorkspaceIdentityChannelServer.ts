import {
  Event,
  type CancellationToken,
  type IChannelServer,
  type IServerChannel,
} from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  type TopicWireAssemblyFault,
  type TopicWireFrameCandidate,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "../logger/serviceLogger.js";

const log = createServiceLogger("source-server-workspace-identity");

export interface SourceServerWorkspaceIdentityMapping {
  stableIdentity: string;
  canonicalIdentity: string;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function mapIdentityString(value: string, mappings: ReadonlyMap<string, string>): string {
  const exact = mappings.get(value);
  if (exact) return exact;

  // Bug 原因：V4 workspace topic 把 identity 编码进复合字符串，旧的整串查表无法命中，
  // 导致 stable 订阅收到 canonical topic 后在 ACK barrier 被静默丢弃。这里只解析已登记的
  // 协议 grammar，禁止通用 substring replace 误改用户文本、路径或日志。
  const sessionsWorkspaceIdentity = parseSessionsIndexTopic(value);
  if (sessionsWorkspaceIdentity) {
    const mapped = mappings.get(sessionsWorkspaceIdentity);
    if (mapped) return sessionsIndexTopic(mapped);
  }
  const configWorkspaceIdentity = parseWorkspaceConfigTopic(value);
  if (configWorkspaceIdentity) {
    const mapped = mappings.get(configWorkspaceIdentity);
    if (mapped) return workspaceConfigTopic(mapped);
  }
  return value;
}

function mapValue(value: unknown, mappings: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return mapIdentityString(value, mappings);
  if (Array.isArray(value)) return value.map((item) => mapValue(item, mappings));
  if (!value || typeof value !== "object") return value;
  // Bug 原因：Host 旧 mapper 对任意 object 执行 Object.entries，顶层 Uint8Array 会退化成
  // 数字键对象，普通 Date/ArrayBuffer 也会丢失运行时语义。Core seam 只遍历 plain record。
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    !isPlainRecord(value)
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapValue(item, mappings)]),
  );
}

function isTopicWireCandidate(value: unknown): value is TopicWireFrameCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "complete" || candidate.kind === "fragment") &&
    typeof candidate.topic === "string" &&
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.logicalFrameId === "string" &&
    typeof candidate.logicalFrameOrdinal === "number"
  );
}

/**
 * Source Server 内部 CLI wire 使用 canonical storage identity；对外 wire 使用 stable identity。
 * logical frame 一旦已分片，必须先有界重组、映射 logical value，再按对外 envelope 重新分片。
 */
function mapTopicWireEvent(
  event: Event<unknown>,
  mapper: SourceServerWorkspaceIdentityMapper,
  createAssembler: () => TopicWireFrameAssembler<unknown>,
): Event<unknown> {
  return (listener) => {
    const assembler = createAssembler();
    const emitFault = (fault: TopicWireAssemblyFault): void => {
      // Bug 原因：旧实现把 fault 对应的原始 fragment 直接透传，base64 内仍包含 canonical
      // identity；跨 route expire 还会把同批已完成帧一起丢掉。candidate boundary 允许缺失
      // inner frame，由控制端 owned assembler 产生 typed fault 并启动既有 resync。
      listener(
        mapper.mapOutgoing({
          wireVersion: V4_WIRE_PROTOCOL_VERSION,
          kind: "complete",
          ...(fault.deliveryKind ? { deliveryKind: fault.deliveryKind } : {}),
          logicalFrameId: fault.logicalFrameId,
          logicalFrameOrdinal: fault.logicalFrameOrdinal,
          topic: fault.topic,
          subscriptionId: fault.subscriptionId,
        }),
      );
    };
    return event((value) => {
      if (!isTopicWireCandidate(value)) {
        listener(mapper.mapOutgoing(value));
        return;
      }
      const assembled = assembler.accept(value);
      for (const item of assembled) {
        if (item.kind === "fault") {
          emitFault(item.fault);
          continue;
        }
        if (item.kind !== "complete") continue;
        const frame = mapper.mapOutgoing(item.frame) as {
          topic: string;
          subscriptionId: string;
        };
        try {
          const wires = encodeTopicWireFrames(frame, {
            deliveryKind: item.deliveryKind,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
            logicalFrameId: value.logicalFrameId,
            logicalFrameOrdinal: value.logicalFrameOrdinal,
            measurePhysicalFrameBytes: (wire) =>
              measureTopicNotificationEnvelopeBytes(wire).maxBytes,
          });
          for (const wire of wires) listener(wire);
        } catch (error) {
          // Bug 原因：encode 异常从 Emitter listener 冒泡后会被 stdio transport 当成
          // protocol_parse_error，连带撕掉整个 CLI runtime。映射 seam 只让当前 topic resync。
          log.warn("failed to encode mapped topic frame", {
            topicLength: frame.topic.length,
            subscriptionId: frame.subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          });
          emitFault({
            deliveryKind: item.deliveryKind,
            reasonCode: "proto.frameMappingEncodingFailed",
            logicalFrameId: value.logicalFrameId,
            logicalFrameOrdinal: value.logicalFrameOrdinal,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
          });
        }
      }
    });
  };
}

export class SourceServerWorkspaceIdentityMapper {
  private readonly stableToCanonical = new Map<string, string>();
  private readonly canonicalToStable = new Map<string, string>();

  public register(mapping: SourceServerWorkspaceIdentityMapping): void {
    this.stableToCanonical.set(mapping.stableIdentity, mapping.canonicalIdentity);
    this.canonicalToStable.set(mapping.canonicalIdentity, mapping.stableIdentity);
  }

  public mapIncoming<T>(value: T): T {
    return mapValue(value, this.stableToCanonical) as T;
  }

  public mapOutgoing<T>(value: T): T {
    return mapValue(value, this.canonicalToStable) as T;
  }
}

class SourceServerWorkspaceIdentityServerChannel<TContext> implements IServerChannel<TContext> {
  public constructor(
    private readonly inner: IServerChannel<TContext>,
    private readonly mapper: SourceServerWorkspaceIdentityMapper,
  ) {}

  public async call<T>(
    context: TContext,
    command: string,
    args?: unknown,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    const result = await this.inner.call<T>(
      context,
      command,
      this.mapper.mapIncoming(args),
      cancellationToken,
    );
    return this.mapper.mapOutgoing(result);
  }

  public listen<T>(context: TContext, event: string, arg?: unknown): Event<T> {
    const innerEvent = this.inner.listen<unknown>(context, event, this.mapper.mapIncoming(arg));
    if (event === "onDynamicConversationFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(conversationTopicFrameSchema),
      ) as Event<T>;
    }
    if (event === "onDynamicSessionsIndexFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      ) as Event<T>;
    }
    if (event === "onDynamicWorkspaceConfigFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      ) as Event<T>;
    }
    return Event.map(innerEvent, (value) => this.mapper.mapOutgoing(value)) as Event<T>;
  }
}

/**
 * 远端 Core 唯一 workspace identity 映射 seam。
 *
 * source-server-workspace channel 返回真实 canonical key 供迁移诊断；其它业务 channel
 * 只观察控制端 stable identity，远端实现只观察 canonical storage key。
 */
export class SourceServerWorkspaceIdentityChannelServer<
  TContext = string,
> implements IChannelServer<TContext> {
  public constructor(
    private readonly inner: IChannelServer<TContext>,
    private readonly mapper: SourceServerWorkspaceIdentityMapper,
  ) {}

  public registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.inner.registerChannel(
      channelName,
      channelName === ServiceChannels.SourceServerWorkspace
        ? channel
        : new SourceServerWorkspaceIdentityServerChannel(channel, this.mapper),
    );
  }

  public ready(): void {
    this.inner.ready?.();
  }
}
