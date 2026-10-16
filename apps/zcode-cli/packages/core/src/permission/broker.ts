// ============================================================
// Permission Broker - async client permission coordination
// ============================================================

import {
  CoreErrorType,
  createCoreError,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
} from "@zcode/contracts";

export interface ManualPermissionBrokerOptions {
  onRequest?: (request: PermissionBrokerRequest) => Promise<void> | void;
}

interface PendingBrokerRecord {
  request: PermissionBrokerRequest;
  resolve: (result: PermissionBrokerResult) => void;
  reject: (error: Error) => void;
}

export class DenyPermissionBroker implements PermissionBrokerPort {
  async requestPermission(request: PermissionBrokerRequest): Promise<PermissionBrokerResult> {
    if (request.mode === "guarded") {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        `No permission client configured for ${request.toolName}`,
        { recoverable: true },
      );
    }
    return {
      decision: "deny",
      reason: `No permission client configured for ${request.toolName}`,
      resolvedAt: new Date(),
    };
  }
}

export class ManualPermissionBroker implements PermissionBrokerPort {
  private readonly pending = new Map<string, PendingBrokerRecord>();

  constructor(private readonly options: ManualPermissionBrokerOptions = {}) {}

  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult> {
    const key = request.requestId;
    if (this.pending.has(key)) {
      return Promise.reject(
        createCoreError(
          CoreErrorType.InvalidStateTransition,
          `Permission request already pending: ${key}`,
          {
            context: { requestId: key, toolCallId: request.toolCallId },
            recoverable: true,
          },
        ),
      );
    }

    return new Promise<PermissionBrokerResult>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        options?.signal?.removeEventListener("abort", abortHandler);
        this.pending.delete(key);
      };

      const settle = (result: PermissionBrokerResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ...result,
          resolvedAt: result.resolvedAt ?? new Date(),
        });
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const abortHandler = () => {
        fail(
          createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
            context: { requestId: key, toolCallId: request.toolCallId, toolName: request.toolName },
            recoverable: true,
          }),
        );
      };

      if (options?.signal?.aborted) {
        abortHandler();
        return;
      }

      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          fail(
            createCoreError(
              CoreErrorType.PermissionTimeout,
              `Permission request timed out after ${options.timeoutMs}ms`,
              {
                context: {
                  requestId: key,
                  timeoutMs: options.timeoutMs,
                  toolCallId: request.toolCallId,
                  toolName: request.toolName,
                },
                recoverable: true,
              },
            ),
          );
        }, options.timeoutMs);
      }

      options?.signal?.addEventListener("abort", abortHandler);
      this.pending.set(key, { request, resolve: settle, reject: fail });

      Promise.resolve(this.options.onRequest?.(request)).catch(fail);
    });
  }

  resolvePermission(requestIdOrToolCallId: string, result: PermissionBrokerResult): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.resolve(result);
    return true;
  }

  rejectPermission(requestIdOrToolCallId: string, error: Error): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.reject(error);
    return true;
  }

  getPendingRequest(requestIdOrToolCallId: string): PermissionBrokerRequest | undefined {
    return this.findPendingRecord(requestIdOrToolCallId)?.request;
  }

  listPendingRequests(): PermissionBrokerRequest[] {
    return Array.from(this.pending.values(), (record) => record.request);
  }

  private findPendingRecord(requestIdOrToolCallId: string): PendingBrokerRecord | undefined {
    const direct = this.pending.get(requestIdOrToolCallId);
    if (direct) return direct;

    return Array.from(this.pending.values()).find(
      (record) => record.request.toolCallId === requestIdOrToolCallId,
    );
  }
}

export const createDenyPermissionBroker = (): PermissionBrokerPort => new DenyPermissionBroker();

export const createManualPermissionBroker = (
  options?: ManualPermissionBrokerOptions,
): ManualPermissionBroker => new ManualPermissionBroker(options);
