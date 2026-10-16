/* eslint-disable max-lines -- raw RPC 的 schema、精确计量、编码与单 assembly 状态机共享同一组物理不变量。 */
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import {
  crc32WireBytes,
  decodeWireBase64,
  encodeWireBytesBase64,
} from "./zcode-protocol-v4/wire-binary.js";

export const WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS = {
  maxPhysicalFrameBytes: PROTOCOL_V4_LIMITS.maxFrameBytes,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
  assemblyTimeoutMs: 30_000,
  transportIdMaxChars: PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars,
} as const;

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const webRemoteControlRpcTransportIdSchema = z
  .string()
  .min(1)
  .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.transportIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const webRemoteControlRpcTransportIdentitySchema = z
  .object({
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
  })
  .strict();
export type WebRemoteControlRpcTransportIdentity = z.infer<
  typeof webRemoteControlRpcTransportIdentitySchema
>;

export const webRemoteControlRpcTransportChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type WebRemoteControlRpcTransportChecksum = z.infer<
  typeof webRemoteControlRpcTransportChecksumSchema
>;

function isCanonicalBase64(value: string): boolean {
  // Zod 的后续 refine 不保证在 max issue 后短路；先按 raw string 做硬闸，避免先分配 decoded buffer。
  if (
    value.length < 4 ||
    value.length > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
  ) {
    return false;
  }
  const decoded = decodeWireBase64(value);
  return decoded !== null && decoded.byteLength > 0 && encodeWireBytesBase64(decoded) === value;
}

export const webRemoteControlRpcTransportFrameSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    seq: positiveSafeIntegerSchema,
    messageSeq: positiveSafeIntegerSchema,
    fragmentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments - 1),
    fragmentCount: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments),
    messageBytes: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes),
    checksum: webRemoteControlRpcTransportChecksumSchema,
    // 先做字符串长度硬闸，再进入 decode/refine，避免恶意超长 base64 先分配 decoded buffer。
    dataBase64: z
      .string()
      .min(4)
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes)
      .refine(isCanonicalBase64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fragmentIndex >= value.fragmentCount) {
      context.addIssue({
        code: "custom",
        path: ["fragmentIndex"],
        message: "fragmentIndex must be smaller than fragmentCount",
      });
    }
    if (value.fragmentCount > value.messageBytes) {
      context.addIssue({
        code: "custom",
        path: ["fragmentCount"],
        message: "non-empty fragments cannot exceed message bytes",
      });
    }
  });
export type WebRemoteControlRpcTransportFramePayload = z.infer<
  typeof webRemoteControlRpcTransportFrameSchema
>;

export const webRemoteControlRpcTransportAckSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    ackMessageSeq: positiveSafeIntegerSchema,
  })
  .strict();
export type WebRemoteControlRpcTransportAckPayload = z.infer<
  typeof webRemoteControlRpcTransportAckSchema
>;

export const webRemoteControlRpcTransportPayloadSchema = z.union([
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
]);
export type WebRemoteControlRpcTransportPayload = z.infer<
  typeof webRemoteControlRpcTransportPayloadSchema
>;

export const webRemoteControlRpcRelayEnvelopeSchema = z
  .object({
    type: z.literal("data"),
    payload: webRemoteControlRpcTransportPayloadSchema,
    client_ts: nonnegativeSafeIntegerSchema.optional(),
    server_ts: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();
export type WebRemoteControlRpcRelayEnvelope = z.infer<
  typeof webRemoteControlRpcRelayEnvelopeSchema
>;

export interface WebRemoteControlRpcTransportFault {
  reasonCode: string;
  terminal: boolean;
  seq?: number;
  messageSeq?: number;
  expectedSeq?: number;
  expectedMessageSeq?: number;
}

export type ParseWebRemoteControlRpcRelayEnvelopeResult =
  | {
      kind: "accepted";
      bytes: number;
      envelope: WebRemoteControlRpcRelayEnvelope;
    }
  | { kind: "fault"; fault: WebRemoteControlRpcTransportFault };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function relayEnvelopeFor(
  payload: WebRemoteControlRpcTransportPayload,
  timestamps: { clientTimestamp?: number | null; serverTimestamp?: number | null } = {},
): WebRemoteControlRpcRelayEnvelope {
  const clientTimestamp =
    timestamps.clientTimestamp === undefined ? Number.MAX_SAFE_INTEGER : timestamps.clientTimestamp;
  const serverTimestamp =
    timestamps.serverTimestamp === undefined ? Number.MAX_SAFE_INTEGER : timestamps.serverTimestamp;
  return {
    type: "data",
    payload,
    ...(clientTimestamp === null ? {} : { client_ts: clientTimestamp }),
    ...(serverTimestamp === null ? {} : { server_ts: serverTimestamp }),
  };
}

/** 最终 relay JSON（默认同时含最坏 client/server timestamp）的精确 UTF-8 byte 数。 */
export function measureWebRemoteControlRpcRelayEnvelopeBytes(
  payload: WebRemoteControlRpcTransportPayload,
  timestamps?: { clientTimestamp?: number | null; serverTimestamp?: number | null },
): number {
  return utf8Bytes(JSON.stringify(relayEnvelopeFor(payload, timestamps)));
}

function boundedPositive(value: number | undefined, maximum: number, reasonCode: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new WebRemoteControlRpcTransportEncodingError(reasonCode);
  }
  return Math.min(resolved, maximum);
}

export function parseWebRemoteControlRpcTransportPayload(
  value: unknown,
): WebRemoteControlRpcTransportPayload | null {
  const result = webRemoteControlRpcTransportPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** D3 接线时在 JSON.parse 前调用；本切片只提供 standalone primitive。 */
export function parseWebRemoteControlRpcRelayEnvelopeJson(
  rawJson: string,
  options: { maxPhysicalFrameBytes?: number } = {},
): ParseWebRemoteControlRpcRelayEnvelopeResult {
  let maxPhysicalFrameBytes: number;
  try {
    maxPhysicalFrameBytes = boundedPositive(
      options.maxPhysicalFrameBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      "remote.rpcFrame.invalidPhysicalLimit",
    );
  } catch (error) {
    return {
      kind: "fault",
      fault: {
        reasonCode:
          error instanceof WebRemoteControlRpcTransportEncodingError
            ? error.reasonCode
            : "remote.rpcFrame.invalidPhysicalLimit",
        terminal: true,
      },
    };
  }
  const bytes = utf8Bytes(rawJson);
  if (bytes > maxPhysicalFrameBytes) {
    return {
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.envelopeTooLarge", terminal: true },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.invalidJson", terminal: true },
    };
  }
  const envelope = webRemoteControlRpcRelayEnvelopeSchema.safeParse(parsed);
  return envelope.success
    ? { kind: "accepted", bytes, envelope: envelope.data }
    : {
        kind: "fault",
        fault: { reasonCode: "remote.rpcFrame.invalidEnvelope", terminal: true },
      };
}

export class WebRemoteControlRpcTransportEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "WebRemoteControlRpcTransportEncodingError";
  }
}

export interface EncodeWebRemoteControlRpcTransportMessageOptions extends WebRemoteControlRpcTransportIdentity {
  firstPhysicalSeq: number;
  messageSeq: number;
  maxPhysicalFrameBytes?: number;
  maxMessageBytes?: number;
  maxFragments?: number;
}

function identityFrom(
  value: WebRemoteControlRpcTransportIdentity,
): WebRemoteControlRpcTransportIdentity {
  const parsed = webRemoteControlRpcTransportIdentitySchema.safeParse({
    bridgeSessionId: value.bridgeSessionId,
    ...(value.bridgeGeneration === undefined ? {} : { bridgeGeneration: value.bridgeGeneration }),
    ...(value.recoveryId === undefined ? {} : { recoveryId: value.recoveryId }),
  });
  if (!parsed.success) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.invalidIdentity");
  }
  return parsed.data;
}

function assertPositiveSafe(value: number, reasonCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebRemoteControlRpcTransportEncodingError(reasonCode);
  }
}

function base64Length(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3);
}

function frameShell(params: {
  identity: WebRemoteControlRpcTransportIdentity;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  dataBase64: string;
}): WebRemoteControlRpcTransportFramePayload {
  return {
    zcode_type: "rpc-frame",
    ...params.identity,
    seq: params.seq,
    messageSeq: params.messageSeq,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

function findDecodedBudget(params: {
  identity: WebRemoteControlRpcTransportIdentity;
  endSeq: number;
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  const empty = frameShell({
    identity: params.identity,
    seq: params.endSeq,
    messageSeq: params.messageSeq,
    fragmentIndex: params.fragmentCount - 1,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    // 这里只用于精确固定 envelope 计量；真正 payload 仍须非空 canonical base64。
    dataBase64: "",
  });
  const fixedBytes = measureWebRemoteControlRpcRelayEnvelopeBytes(empty);
  let low = 0;
  let high = params.messageBytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fixedBytes + base64Length(middle) <= params.maxPhysicalFrameBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** raw Channel bytes -> immutable bounded physical payload batch。 */
export function encodeWebRemoteControlRpcTransportMessage(
  bytes: Uint8Array,
  options: EncodeWebRemoteControlRpcTransportMessageOptions,
): readonly WebRemoteControlRpcTransportFramePayload[] {
  const identity = identityFrom(options);
  assertPositiveSafe(options.firstPhysicalSeq, "remote.rpcFrame.invalidPhysicalSeq");
  assertPositiveSafe(options.messageSeq, "remote.rpcFrame.invalidMessageSeq");
  const maxPhysicalFrameBytes = boundedPositive(
    options.maxPhysicalFrameBytes,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    "remote.rpcFrame.invalidPhysicalLimit",
  );
  const maxMessageBytes = boundedPositive(
    options.maxMessageBytes,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes,
    "remote.rpcFrame.invalidMessageLimit",
  );
  const maxFragments = boundedPositive(
    options.maxFragments,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
    "remote.rpcFrame.invalidFragmentLimit",
  );
  if (bytes.byteLength === 0) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.emptyMessage");
  }
  if (bytes.byteLength > maxMessageBytes) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.messageTooLarge");
  }
  const checksum = Object.freeze({
    algorithm: "crc32" as const,
    value: crc32WireBytes(bytes),
  });

  let fragmentCount = 1;
  let decodedBudget = 0;
  for (;;) {
    const endSeq = options.firstPhysicalSeq + fragmentCount - 1;
    if (!Number.isSafeInteger(endSeq) || endSeq > Number.MAX_SAFE_INTEGER) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.sequenceOverflow");
    }
    decodedBudget = findDecodedBudget({
      identity,
      endSeq,
      messageSeq: options.messageSeq,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      maxPhysicalFrameBytes,
    });
    if (decodedBudget < 1) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.envelopeTooLarge");
    }
    const required = Math.ceil(bytes.byteLength / decodedBudget);
    if (required > maxFragments) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.fragmentLimitExceeded");
    }
    if (required <= fragmentCount) break;
    fragmentCount = required;
  }

  const frames: WebRemoteControlRpcTransportFramePayload[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * decodedBudget;
    const end = Math.min(bytes.byteLength, start + decodedBudget);
    const payload = frameShell({
      identity,
      seq: options.firstPhysicalSeq + fragmentIndex,
      messageSeq: options.messageSeq,
      fragmentIndex,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(bytes.subarray(start, end)),
    });
    if (
      measureWebRemoteControlRpcRelayEnvelopeBytes(payload) > maxPhysicalFrameBytes ||
      !webRemoteControlRpcTransportFrameSchema.safeParse(payload).success
    ) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.internalEnvelopeError");
    }
    frames.push(Object.freeze(payload));
  }
  return Object.freeze(frames);
}

interface ActiveAssembly {
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  firstSeenAt: number;
  stagedBytes: number;
  fragments: Uint8Array[];
  frameFingerprintsBySeq: Map<number, SettledFrameFingerprint>;
}

interface SettledFrameFingerprint {
  messageSeq: number;
  value: string;
}

export type WebRemoteControlRpcTransportAssemblyEvent =
  | { kind: "incomplete"; messageSeq: number; receivedFragments: number }
  | { kind: "duplicate"; ackMessageSeq: number | null }
  | { kind: "complete"; messageSeq: number; bytes: Uint8Array }
  | { kind: "fault"; fault: WebRemoteControlRpcTransportFault };

export interface WebRemoteControlRpcTransportAssemblerOptions {
  identity: WebRemoteControlRpcTransportIdentity;
  initialPhysicalSeq?: number;
  initialMessageSeq?: number;
  maxPhysicalFrameBytes?: number;
  maxMessageBytes?: number;
  maxFragments?: number;
  timeoutMs?: number;
  now?: () => number;
}

function sameIdentity(
  expected: WebRemoteControlRpcTransportIdentity,
  frameValue: WebRemoteControlRpcTransportFramePayload,
): boolean {
  return (
    frameValue.bridgeSessionId === expected.bridgeSessionId &&
    frameValue.bridgeGeneration === expected.bridgeGeneration &&
    frameValue.recoveryId === expected.recoveryId
  );
}

function hasRawIdentityMismatch(
  expected: WebRemoteControlRpcTransportIdentity,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  const identityKeys = ["bridgeSessionId", "bridgeGeneration", "recoveryId"] as const;
  if (!identityKeys.some((key) => key in value)) return false;
  return (
    value.bridgeSessionId !== expected.bridgeSessionId ||
    value.bridgeGeneration !== expected.bridgeGeneration ||
    value.recoveryId !== expected.recoveryId
  );
}

function frameFingerprint(
  frameValue: WebRemoteControlRpcTransportFramePayload,
  decoded: Uint8Array,
): SettledFrameFingerprint {
  return {
    messageSeq: frameValue.messageSeq,
    // 完成后的 tombstone 只保留有界 metadata + fragment digest，不保留整段 base64。
    value: JSON.stringify([
      frameValue.bridgeSessionId,
      frameValue.bridgeGeneration ?? null,
      frameValue.recoveryId ?? null,
      frameValue.seq,
      frameValue.messageSeq,
      frameValue.fragmentIndex,
      frameValue.fragmentCount,
      frameValue.messageBytes,
      frameValue.checksum.algorithm,
      frameValue.checksum.value,
      decoded.byteLength,
      crc32WireBytes(decoded),
    ]),
  };
}

function sameFingerprint(left: SettledFrameFingerprint, right: SettledFrameFingerprint): boolean {
  return left.value === right.value;
}

/** 每方向一个实例；任何 terminal fault 后由 04D-2 映射为 bridge degraded。 */
export class WebRemoteControlRpcTransportAssembler {
  private readonly identity: WebRemoteControlRpcTransportIdentity;
  private readonly maxPhysicalFrameBytes: number;
  private readonly maxMessageBytes: number;
  private readonly maxFragments: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private expectedPhysicalSeq: number;
  private expectedMessageSeq: number;
  private lastCompletedMessageSeq: number;
  private physicalSequenceExhausted = false;
  private messageSequenceExhausted = false;
  private settledFrameFingerprintsBySeq = new Map<number, SettledFrameFingerprint>();
  private active: ActiveAssembly | null = null;
  private terminalReason: string | null = null;

  constructor(options: WebRemoteControlRpcTransportAssemblerOptions) {
    this.identity = identityFrom(options.identity);
    this.expectedPhysicalSeq = options.initialPhysicalSeq ?? 1;
    this.expectedMessageSeq = options.initialMessageSeq ?? 1;
    assertPositiveSafe(this.expectedPhysicalSeq, "remote.rpcFrame.invalidPhysicalSeq");
    assertPositiveSafe(this.expectedMessageSeq, "remote.rpcFrame.invalidMessageSeq");
    this.lastCompletedMessageSeq = this.expectedMessageSeq - 1;
    this.maxPhysicalFrameBytes = boundedPositive(
      options.maxPhysicalFrameBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      "remote.rpcFrame.invalidPhysicalLimit",
    );
    this.maxMessageBytes = boundedPositive(
      options.maxMessageBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes,
      "remote.rpcFrame.invalidMessageLimit",
    );
    this.maxFragments = boundedPositive(
      options.maxFragments,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
      "remote.rpcFrame.invalidFragmentLimit",
    );
    this.timeoutMs = boundedPositive(
      options.timeoutMs,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs,
      "remote.rpcFrame.invalidTimeout",
    );
    this.now = options.now ?? Date.now;
  }

  get nextExpiryAt(): number | null {
    return this.active ? this.active.firstSeenAt + this.timeoutMs : null;
  }

  private fault(
    reasonCode: string,
    terminal: boolean,
    frameValue?: Partial<WebRemoteControlRpcTransportFramePayload>,
  ): WebRemoteControlRpcTransportAssemblyEvent {
    if (terminal) {
      this.terminalReason = reasonCode;
      this.active = null;
    }
    return {
      kind: "fault",
      fault: {
        reasonCode,
        terminal,
        ...(typeof frameValue?.seq === "number" ? { seq: frameValue.seq } : {}),
        ...(typeof frameValue?.messageSeq === "number"
          ? { messageSeq: frameValue.messageSeq }
          : {}),
        expectedSeq: this.expectedPhysicalSeq,
        expectedMessageSeq: this.expectedMessageSeq,
      },
    };
  }

  expire(now: number = this.now()): WebRemoteControlRpcTransportAssemblyEvent | null {
    if (!this.active || now - this.active.firstSeenAt < this.timeoutMs) return null;
    return this.fault("remote.rpcFrame.assemblyTimeout", true, {
      messageSeq: this.active.messageSeq,
    });
  }

  accept(candidate: unknown, now: number = this.now()): WebRemoteControlRpcTransportAssemblyEvent {
    // foreign identity 必须先于本连接的 timeout、schema 与 base64 工作拒绝，否则坏外片会清空 owning assembly。
    if (hasRawIdentityMismatch(this.identity, candidate)) {
      return this.fault("remote.rpcFrame.identityMismatch", false);
    }
    if (this.terminalReason) return this.fault(this.terminalReason, true);
    const expired = this.expire(now);
    if (expired) return expired;

    const rawBase64 =
      typeof candidate === "object" && candidate !== null && "dataBase64" in candidate
        ? (candidate as { dataBase64?: unknown }).dataBase64
        : undefined;
    if (
      typeof rawBase64 === "string" &&
      (rawBase64.length > this.maxPhysicalFrameBytes || !isCanonicalBase64(rawBase64))
    ) {
      return this.fault("remote.rpcFrame.invalidBase64", true);
    }
    const parsed = webRemoteControlRpcTransportFrameSchema.safeParse(candidate);
    if (!parsed.success) return this.fault("remote.rpcFrame.invalidMetadata", true);
    const frameValue = parsed.data;
    if (!sameIdentity(this.identity, frameValue)) {
      return this.fault("remote.rpcFrame.identityMismatch", false, frameValue);
    }
    if (frameValue.messageBytes > this.maxMessageBytes) {
      return this.fault("remote.rpcFrame.messageTooLarge", true, frameValue);
    }
    if (frameValue.fragmentCount > this.maxFragments) {
      return this.fault("remote.rpcFrame.fragmentLimitExceeded", true, frameValue);
    }
    if (measureWebRemoteControlRpcRelayEnvelopeBytes(frameValue) > this.maxPhysicalFrameBytes) {
      return this.fault("remote.rpcFrame.envelopeTooLarge", true, frameValue);
    }

    const decoded = decodeWireBase64(frameValue.dataBase64);
    if (!decoded || decoded.byteLength === 0) {
      return this.fault("remote.rpcFrame.invalidBase64", true, frameValue);
    }
    const fingerprint = frameFingerprint(frameValue, decoded);

    const activeFingerprint = this.active?.frameFingerprintsBySeq.get(frameValue.seq);
    if (activeFingerprint) {
      if (!sameFingerprint(activeFingerprint, fingerprint)) {
        return this.fault("remote.rpcFrame.conflictingDuplicate", true, frameValue);
      }
      return {
        kind: "duplicate",
        ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
      };
    }
    const settledFingerprint = this.settledFrameFingerprintsBySeq.get(frameValue.seq);
    if (settledFingerprint) {
      if (sameFingerprint(settledFingerprint, fingerprint)) {
        return {
          kind: "duplicate",
          ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
        };
      }
      if (
        this.physicalSequenceExhausted &&
        frameValue.messageSeq !== settledFingerprint.messageSeq
      ) {
        return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
      }
      return this.fault("remote.rpcFrame.conflictingDuplicate", true, frameValue);
    }

    if (frameValue.seq < this.expectedPhysicalSeq) {
      return {
        kind: "duplicate",
        ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
      };
    }
    if (this.physicalSequenceExhausted) {
      return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
    }
    if (this.messageSequenceExhausted && !this.active) {
      return this.fault("remote.rpcFrame.messageSequenceExhausted", true, frameValue);
    }
    if (frameValue.seq > this.expectedPhysicalSeq) {
      return this.fault("remote.rpcFrame.physicalGap", true, frameValue);
    }
    if (frameValue.messageSeq !== this.expectedMessageSeq) {
      return this.fault("remote.rpcFrame.messageGap", true, frameValue);
    }

    if (
      frameValue.seq === Number.MAX_SAFE_INTEGER &&
      frameValue.fragmentIndex + 1 < frameValue.fragmentCount
    ) {
      return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
    }

    const expectedFragmentIndex = this.active?.fragments.length ?? 0;
    if (frameValue.fragmentIndex !== expectedFragmentIndex) {
      return this.fault("remote.rpcFrame.fragmentGap", true, frameValue);
    }
    if (
      this.active &&
      (frameValue.fragmentCount !== this.active.fragmentCount ||
        frameValue.messageBytes !== this.active.messageBytes)
    ) {
      return this.fault("remote.rpcFrame.metadataMismatch", true, frameValue);
    }
    if (this.active && frameValue.checksum.value !== this.active.checksum.value) {
      return this.fault("remote.rpcFrame.checksumMismatch", true, frameValue);
    }
    if (!this.active) {
      this.active = {
        messageSeq: frameValue.messageSeq,
        fragmentCount: frameValue.fragmentCount,
        messageBytes: frameValue.messageBytes,
        checksum: frameValue.checksum,
        firstSeenAt: now,
        stagedBytes: 0,
        fragments: [],
        frameFingerprintsBySeq: new Map(),
      };
    }
    if (this.active.stagedBytes + decoded.byteLength > this.active.messageBytes) {
      return this.fault("remote.rpcFrame.lengthMismatch", true, frameValue);
    }
    this.active.fragments.push(decoded);
    this.active.frameFingerprintsBySeq.set(frameValue.seq, fingerprint);
    this.active.stagedBytes += decoded.byteLength;
    if (frameValue.seq === Number.MAX_SAFE_INTEGER) {
      // 本消息可在最大 seq 收口，但任何后继消息都必须新 bridge generation。
      this.physicalSequenceExhausted = true;
    } else {
      this.expectedPhysicalSeq += 1;
    }

    if (this.active.fragments.length < this.active.fragmentCount) {
      return {
        kind: "incomplete",
        messageSeq: frameValue.messageSeq,
        receivedFragments: this.active.fragments.length,
      };
    }
    if (this.active.stagedBytes !== this.active.messageBytes) {
      return this.fault("remote.rpcFrame.lengthMismatch", true, frameValue);
    }
    const completedBytes = new Uint8Array(this.active.messageBytes);
    let offset = 0;
    for (const fragment of this.active.fragments) {
      completedBytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32WireBytes(completedBytes) !== this.active.checksum.value) {
      return this.fault("remote.rpcFrame.checksumMismatch", true, frameValue);
    }
    const completedAssembly = this.active;
    const messageSeq = completedAssembly.messageSeq;
    this.settledFrameFingerprintsBySeq = new Map(completedAssembly.frameFingerprintsBySeq);
    this.active = null;
    this.lastCompletedMessageSeq = messageSeq;
    if (messageSeq === Number.MAX_SAFE_INTEGER) {
      this.messageSequenceExhausted = true;
    } else {
      this.expectedMessageSeq += 1;
    }
    return { kind: "complete", messageSeq, bytes: completedBytes };
  }
}
