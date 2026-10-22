/* oxlint-disable eslint(max-lines) -- task realtime bus owns lease, stream batching, replay and command routing state in one main-process coordinator. */
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  type TaskOwnerCommandDelivery,
  type TaskOwnerCommandRequest,
  type TaskOwnerCommandResult,
  type TaskRealtimeDeliveredEvent,
  type TaskRealtimeEvent,
  type TaskRealtimeHostDeliveryKind,
  type TaskRunLeaseAcquireRequest,
  type TaskRunLeaseResult,
  type TaskRunLeaseTarget,
  type TaskStreamMirrorBatchEvent,
  type TaskStreamMirrorOp,
  type TaskStreamMirrorPublishOp,
  type TaskStreamWatermark,
  formatZodError,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
} from "@zcode/shared";
import { logger as defaultLogger } from "./logger.js";

const STREAM_MIRROR_FLUSH_INTERVAL_MS = 1000;
const STREAM_MIRROR_MAX_REPLAY_BATCHES = 60;
const STREAM_MIRROR_MAX_REPLAY_BYTES = 512 * 1024;
const STREAM_MIRROR_MAX_BATCH_BYTES = 512 * 1024;
const STREAM_MIRROR_TEXT_OP_MAX_CHARS = 128 * 1024;
const OWNER_COMMAND_TIMEOUT_MS = 30_000;
const SESSION_MESSAGE_DELIVERY_TIMEOUT_MS = 30_000;

type HostMessageListener = (message: unknown) => void;
type HostExitListener = () => void;

interface RegisteredRealtimeHost {
  hostId: string;
  windowId: number;
  child: ElectronUtilityProcess;
  workspaceKeys: Set<string>;
  deliveryKind: TaskRealtimeHostDeliveryKind;
  onMessage: HostMessageListener;
  onExit: HostExitListener;
}

interface TaskRunLease {
  key: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  ownerHostId: string;
  acquiredAt: number;
  updatedAt: number;
}

interface PendingStreamBatch {
  batchKey: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  ownerHostId: string;
  nextBatchSeq: number;
  nextOpSeq: number;
  pendingOps: TaskStreamMirrorPublishOp[];
  replay: TaskStreamMirrorBatchEvent[];
  replayUnavailable: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  replayInitializedHostIds: Set<string>;
}

interface PendingOwnerCommandRoute {
  commandRequestId: string;
  requesterHostId: string;
  ownerHostId: string;
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface SessionMessageRequest {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
}

interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}

interface PendingSessionMessageDelivery {
  request: SessionMessageRequest;
  sourceHostId: string;
  targetHostId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface TaskRealtimeBusLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface TaskRealtimeBusOptions {
  logger?: TaskRealtimeBusLogger;
  seenEventLimit?: number;
}

export class TaskRealtimeBus {
  private readonly logger: TaskRealtimeBusLogger;
  private readonly seenEventLimit: number;
  private readonly hosts = new Map<string, RegisteredRealtimeHost>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly leases = new Map<string, TaskRunLease>();
  private readonly streamBatches = new Map<string, PendingStreamBatch>();
  private readonly pendingOwnerCommands = new Map<string, PendingOwnerCommandRoute>();
  private readonly sessionRoutes = new Map<string, string>();
  private readonly pendingSessionMessageDeliveries = new Map<
    string,
    PendingSessionMessageDelivery
  >();

  constructor(options: TaskRealtimeBusOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.seenEventLimit = options.seenEventLimit ?? 1000;
  }

  registerHost(params: {
    hostId: string;
    windowId: number;
    child: ElectronUtilityProcess;
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
  }): void {
    const existing = this.hosts.get(params.hostId);
    if (existing) {
      this.unregisterHost(params.hostId);
    }

    const onMessage: HostMessageListener = (message) => {
      this.handleHostMessage(params.hostId, message);
    };
    const onExit: HostExitListener = () => {
      this.unregisterHost(params.hostId);
    };

    params.child.on("message", onMessage);
    params.child.once("exit", onExit);

    const workspaceKeys = new Set(params.workspaceKeys);
    const deliveryKind = params.deliveryKind ?? "desktop_window";
    this.hosts.set(params.hostId, {
      hostId: params.hostId,
      windowId: params.windowId,
      child: params.child,
      workspaceKeys,
      deliveryKind,
      onMessage,
      onExit,
    });

    this.logger.info("[task-realtime] registered host", {
      hostId: params.hostId,
      windowId: params.windowId,
      workspaceKeyCount: workspaceKeys.size,
      deliveryKind,
    });

    this.replayVisibleRunsToHost(params.hostId, workspaceKeys);
  }

  unregisterHost(hostId: string): void {
    const registered = this.hosts.get(hostId);
    if (!registered) {
      return;
    }

    registered.child.off?.("message", registered.onMessage);
    registered.child.off?.("exit", registered.onExit);
    this.hosts.delete(hostId);
    this.failPendingOwnerCommandsForHost(hostId, "Owner command host exited.");
    this.unregisterSessionRoutesForHost(hostId);
    this.failPendingSessionMessagesForHost(hostId, "Session message host exited.");
    const releasedLeases = this.releaseLeasesForHost(hostId);
    for (const lease of releasedLeases) {
      this.deliverSnapshotInvalidation(lease, hostId, "stream_mirror_owner_lost");
    }

    this.logger.info("[task-realtime] unregistered host", {
      hostId,
      windowId: registered.windowId,
    });
  }

  updateHostWorkspaceKeys(hostId: string, workspaceKeys: Iterable<string>): void {
    const registered = this.hosts.get(hostId);
    if (!registered) {
      this.logger.warn("[task-realtime] workspace update for unknown host", { hostId });
      return;
    }

    const previous = registered.workspaceKeys;
    const next = new Set(workspaceKeys);
    registered.workspaceKeys = next;
    this.logger.info("[task-realtime] updated host workspace scopes", {
      hostId,
      workspaceKeyCount: registered.workspaceKeys.size,
    });
    this.replayVisibleRunsToHost(
      hostId,
      [...next].filter((workspaceKey) => !previous.has(workspaceKey)),
    );
  }

  getHostDeliveryKindForTest(hostId: string): TaskRealtimeHostDeliveryKind | undefined {
    return this.hosts.get(hostId)?.deliveryKind;
  }

  private handleHostMessage(hostId: string, message: unknown): void {
    const parsed = hostResponseMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn(
        "[task-realtime] invalid host response message:",
        formatZodError(parsed.error),
      );
      return;
    }

    const origin = this.hosts.get(hostId);
    if (!origin) {
      this.logger.warn("[task-realtime] publish from unknown host", { hostId });
      return;
    }

    switch (parsed.data.type) {
      case HostResponseTypes.TaskRealtimePublish:
        this.handleRealtimePublish(origin, parsed.data.event as TaskRealtimeEvent);
        break;
      case HostResponseTypes.TaskRunLeaseAcquire:
        this.handleLeaseAcquire(origin, parsed.data.request);
        break;
      case HostResponseTypes.TaskRunLeaseRelease:
        this.releaseLease(origin.hostId, parsed.data.target);
        break;
      case HostResponseTypes.TaskStreamOpPublish:
        this.handleStreamOpPublish(
          origin,
          parsed.data.target,
          parsed.data.op as TaskStreamMirrorPublishOp,
        );
        break;
      case HostResponseTypes.TaskOwnerCommandRequest:
        this.handleOwnerCommandRequest(origin, parsed.data.command);
        break;
      case HostResponseTypes.TaskOwnerCommandResult:
        this.handleOwnerCommandResult(origin, parsed.data.result);
        break;
      case HostResponseTypes.SessionMessageSendRequested:
        this.handleSessionMessageSendRequested(origin, parsed.data.request);
        break;
      case HostResponseTypes.SessionRouteAnnounce:
        this.rememberSessionRoute(origin, parsed.data.route);
        break;
      case HostResponseTypes.SessionMessageDeliverResult:
        this.handleSessionMessageDeliverResult(origin, parsed.data.result);
        break;
      default:
        break;
    }
  }

  private rememberSessionRoute(
    origin: RegisteredRealtimeHost,
    route: {
      sessionId: string;
    },
  ): void {
    this.sessionRoutes.set(route.sessionId, origin.hostId);
  }

  private handleRealtimePublish(origin: RegisteredRealtimeHost, event: TaskRealtimeEvent): void {
    if (!this.rememberEventId(event.eventId)) {
      return;
    }
    this.flushMatchingStreamBatchBeforeInvalidation(event);
    this.deliverRealtimeEvent({ ...event, originHostId: origin.hostId }, () => true);
  }

  private handleLeaseAcquire(
    origin: RegisteredRealtimeHost,
    request: TaskRunLeaseAcquireRequest,
  ): void {
    origin.child.postMessage({
      type: HostMessageTypes.TaskRunLeaseResult,
      result: this.acquireLease(origin.hostId, request),
    });
  }

  private getLeaseKey(workspaceKey: string, taskId: string): string {
    return `${workspaceKey}\u0000${taskId}`;
  }

  private getBatchKey(workspaceKey: string, taskId: string, runId: string): string {
    return `${this.getLeaseKey(workspaceKey, taskId)}\u0000${runId}`;
  }

  private acquireLease(hostId: string, request: TaskRunLeaseAcquireRequest): TaskRunLeaseResult {
    const key = this.getLeaseKey(request.workspaceKey, request.taskId);
    const existing = this.leases.get(key);
    if (existing && (existing.ownerHostId !== hostId || existing.runId !== request.runId)) {
      return {
        leaseRequestId: request.leaseRequestId,
        acquired: false,
        ownerHostId: existing.ownerHostId,
        reason: "owned_by_other_host",
      };
    }

    const now = Date.now();
    this.leases.set(key, {
      key,
      workspaceKey: request.workspaceKey,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      taskId: request.taskId,
      runId: request.runId,
      traceId: request.traceId,
      ownerClientId: request.ownerClientId,
      ownerDeviceLabel: request.ownerDeviceLabel,
      ownerHostId: hostId,
      acquiredAt: existing?.acquiredAt ?? now,
      updatedAt: now,
    });
    this.logger.info("[task-realtime] task run lease acquired", {
      hostId,
      workspaceKey: request.workspaceKey,
      taskId: request.taskId,
      runId: request.runId,
    });
    return { leaseRequestId: request.leaseRequestId, acquired: true, ownerHostId: hostId };
  }

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      streamBatches: this.streamBatches.size,
      leases: this.leases.size,
      sessionRoutes: this.sessionRoutes.size,
    };
  }

  private releaseLease(hostId: string, target: TaskRunLeaseTarget): void {
    const key = this.getLeaseKey(target.workspaceKey, target.taskId);
    const existing = this.leases.get(key);
    if (!existing || existing.ownerHostId !== hostId || existing.runId !== target.runId) {
      return;
    }
    this.flushBatch(this.getBatchKey(target.workspaceKey, target.taskId, target.runId), true);
    this.leases.delete(key);
    this.logger.info("[task-realtime] task run lease released", {
      hostId,
      workspaceKey: target.workspaceKey,
      taskId: target.taskId,
      runId: target.runId,
    });
  }

  private releaseLeasesForHost(hostId: string): TaskRunLease[] {
    const released: TaskRunLease[] = [];
    for (const [key, lease] of this.leases) {
      if (lease.ownerHostId !== hostId) {
        continue;
      }
      this.flushBatch(this.getBatchKey(lease.workspaceKey, lease.taskId, lease.runId), true);
      this.leases.delete(key);
      released.push(lease);
    }
    return released;
  }

  private handleStreamOpPublish(
    origin: RegisteredRealtimeHost,
    target: TaskRunLeaseTarget,
    op: TaskStreamMirrorPublishOp,
  ): void {
    const lease = this.leases.get(this.getLeaseKey(target.workspaceKey, target.taskId));
    if (!lease || lease.ownerHostId !== origin.hostId || lease.runId !== target.runId) {
      return;
    }

    const batchKey = this.getBatchKey(target.workspaceKey, target.taskId, target.runId);
    const batch = this.getOrCreateBatch(batchKey, origin.hostId, target);
    batch.pendingOps.push(op);

    if (this.isTerminalOrImmediateOp(op)) {
      this.flushBatch(batchKey, true);
      if (op.kind === "stream_event" && this.isTerminalEventType(op.event.type)) {
        this.leases.delete(this.getLeaseKey(target.workspaceKey, target.taskId));
      }
      return;
    }

    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        batch.timer = null;
        this.flushBatch(batchKey, false);
      }, STREAM_MIRROR_FLUSH_INTERVAL_MS);
    }
  }

  private getOrCreateBatch(
    batchKey: string,
    ownerHostId: string,
    target: TaskRunLeaseTarget,
  ): PendingStreamBatch {
    let batch = this.streamBatches.get(batchKey);
    if (batch) {
      return batch;
    }
    batch = {
      batchKey,
      workspaceKey: target.workspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      runId: target.runId,
      traceId: target.traceId,
      ownerClientId: target.ownerClientId,
      ownerDeviceLabel: target.ownerDeviceLabel,
      ownerHostId,
      nextBatchSeq: 1,
      nextOpSeq: 1,
      pendingOps: [],
      replay: [],
      replayUnavailable: false,
      timer: null,
      replayInitializedHostIds: new Set<string>(),
    };
    this.streamBatches.set(batchKey, batch);
    return batch;
  }

  private flushMatchingStreamBatchBeforeInvalidation(event: TaskRealtimeEvent): void {
    if (
      event.type === "task_stream_mirror_batch" ||
      !("taskId" in event) ||
      !event.taskId ||
      (event.reason !== "user_message_saved" &&
        event.reason !== "assistant_message_saved" &&
        event.reason !== "task_status_changed")
    ) {
      return;
    }
    this.flushBatch(this.getBatchKey(event.workspaceKey, event.taskId, event.traceId), true);
  }

  private flushBatch(batchKey: string, force: boolean): void {
    const batch = this.streamBatches.get(batchKey);
    if (!batch || batch.pendingOps.length === 0) {
      return;
    }
    if (!force && batch.pendingOps.length === 0) {
      return;
    }
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    const coalesced = this.splitLargeTextOps(this.coalesceOps(batch.pendingOps));
    batch.pendingOps = [];
    const ops: TaskStreamMirrorOp[] = coalesced.map((op) => ({
      ...op,
      seq: batch.nextOpSeq++,
    }));
    const event: TaskStreamMirrorBatchEvent = {
      type: "task_stream_mirror_batch",
      eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batch.nextBatchSeq}`,
      workspacePath: batch.workspacePath,
      workspaceIdentity: batch.workspaceIdentity,
      workspaceKey: batch.workspaceKey,
      traceId: batch.traceId,
      createdAt: Date.now(),
      taskId: batch.taskId,
      runId: batch.runId,
      ownerClientId: batch.ownerClientId,
      ownerDeviceLabel: batch.ownerDeviceLabel,
      batchSeq: batch.nextBatchSeq++,
      fromSeq: ops[0]?.seq ?? batch.nextOpSeq,
      toSeq: ops[ops.length - 1]?.seq ?? batch.nextOpSeq - 1,
      ops,
      terminal: ops.some(
        (op) => op.kind === "stream_event" && this.isTerminalEventType(op.event.type),
      ),
    };
    if (JSON.stringify(event).length > STREAM_MIRROR_MAX_BATCH_BYTES) {
      // 单次 mirror batch 过大时，RPC/base64/JSON 会在链路上多次复制，导致 host 堆内存打满。
      // owner 仍依赖 mirror seq 流渲染主动发送端，所以这里对 owner 做小批次分片；observer
      // 不消费正文流，只收到 snapshot invalidation/remoteGenerating 状态。
      this.deliverOversizedStreamBatchFallback(batch, event);
      return;
    }
    this.rememberReplayBatch(batch, event);
    this.deliverStreamBatch(batch, event);

    if (event.terminal) {
      this.streamBatches.delete(batchKey);
    }
  }

  private deliverOversizedStreamBatchFallback(
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
  ): void {
    // 不能丢弃 owner 的 mirror seq。ZCode Agent 有 realtime port 时 owner direct stream 会被关闭，
    // 如果 oversized batch 只发 gap，service 会因为后续 seq 缺口禁用 mirror，桌面端就停到终态快照。
    // 这里只给 owner 发送连续小批次；observer 和 late subscriber 统一走快照补齐，避免大 payload 扩散。
    batch.replayUnavailable = true;
    batch.replay = [];
    for (const chunk of this.splitOversizedBatchForOwner(batch, event)) {
      this.deliverStreamBatchToHost(batch.ownerHostId, batch, chunk, "relay_owner");
    }
    this.deliverSnapshotInvalidation(
      this.batchToLeaseLike(batch),
      batch.ownerHostId,
      "stream_mirror_gap",
      undefined,
      { runId: event.runId, opSeq: event.toSeq },
    );
    if (event.terminal) {
      this.streamBatches.delete(batch.batchKey);
    }
  }

  private splitOversizedBatchForOwner(
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
  ): TaskStreamMirrorBatchEvent[] {
    const chunks: TaskStreamMirrorBatchEvent[] = [];
    let pendingOps: TaskStreamMirrorOp[] = [];

    const createChunk = (
      ops: TaskStreamMirrorOp[],
      batchSeq: number,
    ): TaskStreamMirrorBatchEvent => ({
      ...event,
      eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batchSeq}`,
      batchSeq,
      fromSeq: ops[0]?.seq ?? event.fromSeq,
      toSeq: ops[ops.length - 1]?.seq ?? event.toSeq,
      ops,
      terminal: ops.some(
        (op) => op.kind === "stream_event" && this.isTerminalEventType(op.event.type),
      ),
    });

    const flushPending = () => {
      if (pendingOps.length === 0) {
        return;
      }
      chunks.push(createChunk(pendingOps, batch.nextBatchSeq++));
      pendingOps = [];
    };

    for (const op of event.ops) {
      const candidate = [...pendingOps, op];
      const candidateChunk = createChunk(candidate, batch.nextBatchSeq);
      if (
        pendingOps.length > 0 &&
        JSON.stringify(candidateChunk).length > STREAM_MIRROR_MAX_BATCH_BYTES
      ) {
        flushPending();
      }
      pendingOps.push(op);
    }
    flushPending();
    return chunks;
  }

  private coalesceOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
    const coalesced: TaskStreamMirrorPublishOp[] = [];
    for (const op of ops) {
      const previous = coalesced[coalesced.length - 1];
      if (this.canMergeTextChunk(previous, op)) {
        const current = op as Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
          event: { content: string };
        };
        coalesced[coalesced.length - 1] = {
          kind: "stream_event",
          event: {
            ...previous.event,
            content: previous.event.content + current.event.content,
          },
        };
        continue;
      }
      if (
        previous?.kind === "stream_event" &&
        op.kind === "stream_event" &&
        this.isRedundantStateEvent(op.event.type) &&
        previous.event.type === op.event.type &&
        previous.event.taskId === op.event.taskId
      ) {
        coalesced[coalesced.length - 1] = op;
        continue;
      }
      coalesced.push(op);
    }
    return coalesced;
  }

  private splitLargeTextOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
    const splitOps: TaskStreamMirrorPublishOp[] = [];
    for (const op of ops) {
      if (
        op.kind !== "stream_event" ||
        (op.event.type !== "agent_message_chunk" && op.event.type !== "agent_thought_chunk") ||
        op.event.content.length <= STREAM_MIRROR_TEXT_OP_MAX_CHARS
      ) {
        splitOps.push(op);
        continue;
      }

      // 文本 chunk 可能被 coalesce 合成超大单 op；后续即使按 op 分 batch，
      // 单个 op 仍会超过 RPC 安全预算。这里先把文本切成连续小 op，再统一分配 seq。
      for (
        let offset = 0;
        offset < op.event.content.length;
        offset += STREAM_MIRROR_TEXT_OP_MAX_CHARS
      ) {
        splitOps.push({
          kind: "stream_event",
          event: {
            ...op.event,
            content: op.event.content.slice(offset, offset + STREAM_MIRROR_TEXT_OP_MAX_CHARS),
          },
        });
      }
    }
    return splitOps;
  }

  private canMergeTextChunk(
    previous: TaskStreamMirrorPublishOp | undefined,
    op: TaskStreamMirrorPublishOp,
  ): previous is Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
    event: {
      type: "agent_message_chunk" | "agent_thought_chunk";
      taskId: string;
      traceId: string;
      content: string;
    };
  } {
    return (
      previous?.kind === "stream_event" &&
      op.kind === "stream_event" &&
      (op.event.type === "agent_message_chunk" || op.event.type === "agent_thought_chunk") &&
      previous.event.type === op.event.type &&
      previous.event.taskId === op.event.taskId &&
      previous.event.traceId === op.event.traceId &&
      "content" in previous.event &&
      "content" in op.event &&
      typeof previous.event.content === "string" &&
      typeof op.event.content === "string"
    );
  }

  private isRedundantStateEvent(type: string): boolean {
    return type === "usage_update" || type === "session_info_update" || type === "plan";
  }

  private isTerminalEventType(type: string): boolean {
    return type === "task_complete" || type === "task_error";
  }

  private isTerminalOrImmediateOp(op: TaskStreamMirrorPublishOp): boolean {
    return (
      op.kind === "stream_event" &&
      (op.event.type === "permission_request" || this.isTerminalEventType(op.event.type))
    );
  }

  private deliverStreamBatch(batch: PendingStreamBatch, event: TaskStreamMirrorBatchEvent): void {
    for (const target of this.hosts.values()) {
      if (!target.workspaceKeys.has(batch.workspaceKey)) {
        continue;
      }
      target.child.postMessage({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: {
          ...event,
          originHostId: batch.ownerHostId,
          // owner 和 observer 以前消费两条不同事件源：owner 走不可重放 direct event，
          // observer 走 mirror batch。切换 task 或跨端 relay 时两边会因为事件丢失/乱序产生分叉。
          // 这里统一把 mirror batch 回投给 owner，让所有 renderer 都按同一条 seq 流更新 task store。
          deliveryPurpose: target.hostId === batch.ownerHostId ? "relay_owner" : "observer",
        } satisfies TaskRealtimeDeliveredEvent,
      });
    }
  }

  private deliverStreamBatchToHost(
    hostId: string,
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
    deliveryPurpose: "relay_owner" | "observer",
  ): void {
    const target = this.hosts.get(hostId);
    if (!target?.workspaceKeys.has(batch.workspaceKey)) {
      return;
    }
    target.child.postMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...event,
        originHostId: batch.ownerHostId,
        deliveryPurpose,
      } satisfies TaskRealtimeDeliveredEvent,
    });
  }

  private rememberReplayBatch(batch: PendingStreamBatch, event: TaskStreamMirrorBatchEvent): void {
    // 无上限 replay 在长任务中会线性占用主进程内存。
    // 这里恢复批次数+字节数双阈值，超限后由 replayVisibleRunsToHost 触发 stream_mirror_gap 并走快照补齐。
    batch.replay.push(event);
    while (batch.replay.length > STREAM_MIRROR_MAX_REPLAY_BATCHES) {
      batch.replay.shift();
    }
    while (this.replayBytes(batch.replay) > STREAM_MIRROR_MAX_REPLAY_BYTES) {
      batch.replay.shift();
    }
  }

  private replayBytes(replay: TaskStreamMirrorBatchEvent[]): number {
    return replay.reduce((total, replayEvent) => total + JSON.stringify(replayEvent).length, 0);
  }

  private replayVisibleRunsToHost(hostId: string, workspaceKeys: Iterable<string>): void {
    const host = this.hosts.get(hostId);
    if (!host) {
      return;
    }
    const visible = new Set(workspaceKeys);
    for (const batch of this.streamBatches.values()) {
      if (!visible.has(batch.workspaceKey)) {
        continue;
      }
      const replayKey = `${hostId}\u0000${batch.workspaceKey}\u0000${batch.taskId}\u0000${batch.runId}`;
      if (batch.replayInitializedHostIds.has(replayKey)) {
        continue;
      }
      batch.replayInitializedHostIds.add(replayKey);
      if (batch.replayUnavailable || batch.replay.length === 0 || batch.replay[0]?.fromSeq !== 1) {
        this.deliverSnapshotInvalidation(
          this.batchToLeaseLike(batch),
          batch.ownerHostId,
          "stream_mirror_gap",
          hostId,
          this.getReplaySnapshotWatermark(batch),
        );
        continue;
      }
      for (const event of batch.replay) {
        host.child.postMessage({
          type: HostMessageTypes.TaskRealtimeDeliver,
          event: { ...event, originHostId: batch.ownerHostId, deliveryPurpose: "observer" },
        });
      }
    }
  }

  private batchToLeaseLike(batch: PendingStreamBatch): TaskRunLease {
    return {
      key: this.getLeaseKey(batch.workspaceKey, batch.taskId),
      workspaceKey: batch.workspaceKey,
      workspacePath: batch.workspacePath,
      workspaceIdentity: batch.workspaceIdentity,
      taskId: batch.taskId,
      runId: batch.runId,
      traceId: batch.traceId,
      ownerClientId: batch.ownerClientId,
      ownerDeviceLabel: batch.ownerDeviceLabel,
      ownerHostId: batch.ownerHostId,
      acquiredAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private deliverSnapshotInvalidation(
    lease: TaskRunLease,
    originHostId: string,
    reason: "stream_mirror_owner_lost" | "stream_mirror_gap",
    onlyHostId?: string,
    streamWatermark?: TaskStreamWatermark,
  ): void {
    this.deliverRealtimeEvent(
      {
        type: "task_snapshot_invalidated",
        eventId: `${reason}-${lease.workspaceKey}-${lease.taskId}-${lease.runId}-${Date.now()}`,
        workspacePath: lease.workspacePath,
        workspaceIdentity: lease.workspaceIdentity,
        workspaceKey: lease.workspaceKey,
        reason,
        traceId: lease.traceId,
        createdAt: Date.now(),
        taskId: lease.taskId,
        ...(streamWatermark ? { streamWatermark } : {}),
        originHostId,
      },
      (target) => (onlyHostId ? target.hostId === onlyHostId : target.hostId !== originHostId),
    );
  }

  private getReplaySnapshotWatermark(batch: PendingStreamBatch): TaskStreamWatermark {
    return {
      runId: batch.runId,
      opSeq: batch.replay.at(-1)?.toSeq ?? Math.max(batch.nextOpSeq - 1, 0),
    };
  }

  private deliverRealtimeEvent(
    delivered: TaskRealtimeDeliveredEvent,
    shouldDeliver: (target: RegisteredRealtimeHost) => boolean,
  ): void {
    for (const target of this.hosts.values()) {
      if (!shouldDeliver(target) || !target.workspaceKeys.has(delivered.workspaceKey)) {
        continue;
      }
      target.child.postMessage({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: delivered,
      });
    }
  }

  private handleOwnerCommandRequest(
    requester: RegisteredRealtimeHost,
    command: TaskOwnerCommandRequest,
  ): void {
    const lease = this.leases.get(this.getLeaseKey(command.workspaceKey, command.taskId));
    if (!lease) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "No active task owner.",
        code: "NO_ACTIVE_TASK_OWNER",
      });
      return;
    }
    if (lease.runId !== command.runId) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "Stale task owner command.",
        code: "STALE_TASK_OWNER_COMMAND",
      });
      return;
    }
    const owner = this.hosts.get(lease.ownerHostId);
    if (!owner) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "No active task owner.",
        code: "NO_ACTIVE_TASK_OWNER",
      });
      return;
    }

    const timeout = setTimeout(() => {
      this.pendingOwnerCommands.delete(command.commandRequestId);
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "Owner command timed out.",
        code: "OWNER_COMMAND_FAILED",
      });
    }, OWNER_COMMAND_TIMEOUT_MS);
    this.pendingOwnerCommands.set(command.commandRequestId, {
      commandRequestId: command.commandRequestId,
      requesterHostId: requester.hostId,
      ownerHostId: owner.hostId,
      createdAt: Date.now(),
      timeout,
    });

    owner.child.postMessage({
      type: HostMessageTypes.TaskOwnerCommandDeliver,
      command: { ...command, requesterHostId: requester.hostId } satisfies TaskOwnerCommandDelivery,
    });
  }

  private handleOwnerCommandResult(
    owner: RegisteredRealtimeHost,
    result: TaskOwnerCommandResult,
  ): void {
    const pending = this.pendingOwnerCommands.get(result.commandRequestId);
    if (!pending || pending.ownerHostId !== owner.hostId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOwnerCommands.delete(result.commandRequestId);
    this.postOwnerCommandResult(pending.requesterHostId, result);
  }

  private postOwnerCommandResult(hostId: string, result: TaskOwnerCommandResult): void {
    this.hosts.get(hostId)?.child.postMessage({
      type: HostMessageTypes.TaskOwnerCommandResult,
      result,
    });
  }

  private handleSessionMessageSendRequested(
    source: RegisteredRealtimeHost,
    request: SessionMessageRequest,
  ): void {
    const targetHostId = this.sessionRoutes.get(request.toSessionId);
    if (!targetHostId) {
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: `target session not found: ${request.toSessionId}`,
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
      return;
    }

    const target = this.hosts.get(targetHostId);
    if (!target) {
      this.sessionRoutes.delete(request.toSessionId);
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: `target host not found for session: ${request.toSessionId}`,
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
      return;
    }

    const existing = this.pendingSessionMessageDeliveries.get(request.requestId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingSessionMessageDeliveries.delete(request.requestId);
    }

    const timeout = setTimeout(() => {
      this.pendingSessionMessageDeliveries.delete(request.requestId);
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: "Session message delivery timed out.",
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
    }, SESSION_MESSAGE_DELIVERY_TIMEOUT_MS);
    this.pendingSessionMessageDeliveries.set(request.requestId, {
      request,
      sourceHostId: source.hostId,
      targetHostId: target.hostId,
      timeout,
    });

    target.child.postMessage({
      type: HostMessageTypes.SessionMessageDeliver,
      request,
    });
  }

  private handleSessionMessageDeliverResult(
    target: RegisteredRealtimeHost,
    result: SessionMessageDeliveryResult,
  ): void {
    const pending = this.pendingSessionMessageDeliveries.get(result.requestId);
    if (!pending || pending.targetHostId !== target.hostId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingSessionMessageDeliveries.delete(result.requestId);
    this.postSessionMessageDeliveryResult(pending.sourceHostId, result);
  }

  private postSessionMessageDeliveryResult(
    hostId: string,
    result: SessionMessageDeliveryResult,
  ): void {
    this.hosts.get(hostId)?.child.postMessage({
      type: HostMessageTypes.SessionMessageDeliveryResult,
      result,
    });
  }

  private unregisterSessionRoutesForHost(hostId: string): void {
    for (const [sessionId, routeHostId] of this.sessionRoutes) {
      if (routeHostId === hostId) {
        this.sessionRoutes.delete(sessionId);
      }
    }
  }

  private failPendingSessionMessagesForHost(hostId: string, error: string): void {
    const pendingDeliveries = Array.from(this.pendingSessionMessageDeliveries);
    for (const [requestId, pending] of pendingDeliveries) {
      if (pending.sourceHostId !== hostId && pending.targetHostId !== hostId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingSessionMessageDeliveries.delete(requestId);
      if (pending.sourceHostId !== hostId) {
        this.postSessionMessageDeliveryResult(pending.sourceHostId, {
          error,
          messageId: pending.request.messageId,
          requestId,
          sessionId: pending.request.fromSessionId,
          status: "failed",
        });
      }
    }
  }

  private failPendingOwnerCommandsForHost(hostId: string, error: string): void {
    const pendingCommands = Array.from(this.pendingOwnerCommands);
    for (const [commandRequestId, pending] of pendingCommands) {
      if (pending.ownerHostId !== hostId && pending.requesterHostId !== hostId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOwnerCommands.delete(commandRequestId);
      if (pending.requesterHostId !== hostId) {
        this.postOwnerCommandResult(pending.requesterHostId, {
          commandRequestId,
          success: false,
          error,
          code: "OWNER_COMMAND_FAILED",
        });
      }
    }
  }

  private rememberEventId(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) {
      return false;
    }

    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);

    while (this.seenEventOrder.length > this.seenEventLimit) {
      const removed = this.seenEventOrder.shift();
      if (removed) {
        this.seenEventIds.delete(removed);
      }
    }

    return true;
  }
}
