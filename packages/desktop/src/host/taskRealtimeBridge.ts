import type { SessionRealtimePort } from "@zcode/services";
import {
  type TaskRealtimeHostDeliveryKind,
  createUuid,
  type TaskOwnerCommandDelivery,
  type TaskOwnerCommandResult,
  type TaskRealtimeDeliveredEvent,
  type TaskRealtimeEvent,
  type TaskRunLeaseResult,
  HostMessageTypes,
  HostResponseTypes,
  hostIncomingMessageSchema,
} from "@zcode/shared";

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface HostInitLike {
  type: string;
  hostId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
}

const DEFAULT_SEEN_EVENT_LIMIT = 1000;

export function createTaskRealtimeBridgeForHostInit(
  message: HostInitLike,
  parentPort: ParentPortLike,
): SessionRealtimePort | null {
  if (message.type !== HostMessageTypes.InitLocal) {
    return null;
  }
  if (!message.hostId) {
    return null;
  }

  return createTaskRealtimeBridge({
    hostId: message.hostId,
    deliveryKind: message.deliveryKind,
    parentPort,
  });
}

export function createTaskRealtimeBridge(params: {
  hostId: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  parentPort: ParentPortLike;
  seenEventLimit?: number;
}): SessionRealtimePort {
  const listeners = new Set<(event: TaskRealtimeDeliveredEvent) => void>();
  const ownerCommandListeners = new Set<(command: TaskOwnerCommandDelivery) => void>();
  const pendingLeaseRequests = new Map<
    string,
    {
      resolve(result: TaskRunLeaseResult): void;
      reject(error: Error): void;
    }
  >();
  const pendingOwnerCommands = new Map<
    string,
    {
      resolve(result: TaskOwnerCommandResult): void;
      reject(error: Error): void;
    }
  >();
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const seenEventLimit = Math.max(1, params.seenEventLimit ?? DEFAULT_SEEN_EVENT_LIMIT);
  let disposed = false;

  const rememberEventId = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      return false;
    }

    seenEventIds.add(eventId);
    seenEventOrder.push(eventId);

    while (seenEventOrder.length > seenEventLimit) {
      const removed = seenEventOrder.shift();
      if (removed) {
        seenEventIds.delete(removed);
      }
    }

    return true;
  };

  const onMessage = (messageEvent: { data: unknown }) => {
    if (disposed) {
      return;
    }

    const parsed = hostIncomingMessageSchema.safeParse(messageEvent.data);
    if (!parsed.success) {
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskRunLeaseResult) {
      const pending = pendingLeaseRequests.get(parsed.data.result.leaseRequestId);
      if (!pending) {
        return;
      }
      pendingLeaseRequests.delete(parsed.data.result.leaseRequestId);
      pending.resolve(parsed.data.result);
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskOwnerCommandResult) {
      const pending = pendingOwnerCommands.get(parsed.data.result.commandRequestId);
      if (!pending) {
        return;
      }
      pendingOwnerCommands.delete(parsed.data.result.commandRequestId);
      pending.resolve(parsed.data.result);
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskOwnerCommandDeliver) {
      for (const listener of ownerCommandListeners) {
        listener(parsed.data.command);
      }
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskRealtimeDeliver) {
      // host typecheck 之前未覆盖 realtime bridge，schema 推导里 stream event payload 比
      // TaskRealtimeDeliveredEvent 合约更宽。这里在消息通过共享 schema 校验后收口到共享合约，
      // 保持 desktop continuous 与 web remote replayable 仍走同一条 delivery 边界。
      // 同时把 eventId 去重缓存限制在固定窗口内，避免异常高频 relay 把 host 内存线性吃满。
      const event = parsed.data.event as TaskRealtimeDeliveredEvent;
      if (!rememberEventId(event.eventId)) {
        return;
      }

      for (const listener of listeners) {
        listener(event);
      }
    }
  };

  params.parentPort.on("message", onMessage);

  return {
    hostId: params.hostId,
    deliveryKind: params.deliveryKind ?? "desktop_window",
    publish(event: TaskRealtimeEvent): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskRealtimePublish,
        event,
      });
    },
    acquireTaskRunLease(request): Promise<TaskRunLeaseResult> {
      if (disposed) {
        return Promise.reject(new Error("task realtime bridge disposed"));
      }
      const leaseRequestId = createUuid();
      return new Promise((resolve, reject) => {
        pendingLeaseRequests.set(leaseRequestId, { resolve, reject });
        params.parentPort.postMessage({
          type: HostResponseTypes.TaskRunLeaseAcquire,
          request: {
            ...request,
            leaseRequestId,
          },
        });
      });
    },
    releaseTaskRunLease(target): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskRunLeaseRelease,
        target,
      });
    },
    publishStreamOp(target, op): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskStreamOpPublish,
        target,
        op,
      });
    },
    requestOwnerCommand(command): Promise<TaskOwnerCommandResult> {
      if (disposed) {
        return Promise.reject(new Error("task realtime bridge disposed"));
      }
      const commandRequestId = createUuid();
      return new Promise((resolve, reject) => {
        pendingOwnerCommands.set(commandRequestId, { resolve, reject });
        params.parentPort.postMessage({
          type: HostResponseTypes.TaskOwnerCommandRequest,
          command: {
            ...command,
            commandRequestId,
          },
        });
      });
    },
    onDidReceiveEvent(listener): { dispose(): void } {
      if (disposed) {
        return { dispose: () => {} };
      }
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    onDidReceiveOwnerCommand(listener): { dispose(): void } {
      if (disposed) {
        return { dispose: () => {} };
      }
      ownerCommandListeners.add(listener);
      return {
        dispose: () => {
          ownerCommandListeners.delete(listener);
        },
      };
    },
    publishOwnerCommandResult(result): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskOwnerCommandResult,
        result,
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      const error = new Error("task realtime bridge disposed");
      for (const pending of pendingLeaseRequests.values()) {
        pending.reject(error);
      }
      for (const pending of pendingOwnerCommands.values()) {
        pending.reject(error);
      }
      pendingLeaseRequests.clear();
      pendingOwnerCommands.clear();
      listeners.clear();
      ownerCommandListeners.clear();
      seenEventIds.clear();
      seenEventOrder.length = 0;
      params.parentPort.off("message", onMessage);
    },
  };
}
