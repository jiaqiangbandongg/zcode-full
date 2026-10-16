import type { WindowHostAttachmentScope } from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

export interface WindowHostAttachmentPort {
  once(event: "close", listener: () => void): unknown;
}

export interface WindowHostAttachmentHandle {
  dispose(): void;
}

export interface WindowHostResolvedAttachmentScope<TServices, TCapabilities = never> {
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
}

export interface WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities = never> {
  requestId: string;
  attachmentId: string;
  clientMode: ZCodeAgentV4ClientMode;
  scope: WindowHostAttachmentScope;
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
  port: TPort;
}

interface TrackedAttachment<TServices, TPort, TCapabilities = never> {
  params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>;
  handle: WindowHostAttachmentHandle;
  disposed: boolean;
}

export function createWindowHostAttachmentRegistry<
  TServices,
  TPort extends WindowHostAttachmentPort,
  TCapabilities = never,
>(options: {
  resolveScope: (
    scope: WindowHostAttachmentScope,
  ) => WindowHostResolvedAttachmentScope<TServices, TCapabilities>;
  expose: (
    params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>,
  ) => WindowHostAttachmentHandle;
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  function disposeTracked(tracked: TrackedAttachment<TServices, TPort, TCapabilities>): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose();
  }

  function attach(params: {
    requestId: string;
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    scope: WindowHostAttachmentScope;
    port: TPort;
  }): void {
    // scope 必须先由 Host registry 验证；验证失败时不能影响同 attachmentId 的现有端口。
    const resolved = options.resolveScope(params.scope);
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      ...params,
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    };
    const handle = options.expose(exposedParams);
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    const previous = attachments.get(params.attachmentId);
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
    disposeTracked(tracked);
  }

  function detachStaleRemoteSessionAttachments(
    remoteSessionId: string,
    currentGeneration: number,
  ): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId ||
        tracked.params.generation === currentGeneration
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachRemoteSessionAttachments(remoteSessionId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  return {
    attach,
    detach,
    detachRemoteSessionAttachments,
    detachStaleRemoteSessionAttachments,
    size: () => attachments.size,
    list: () =>
      Array.from(attachments.values(), (tracked) => ({
        requestId: tracked.params.requestId,
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        generation: tracked.params.generation,
      })),
    dispose(): void {
      for (const tracked of attachments.values()) {
        disposeTracked(tracked);
      }
      attachments.clear();
    },
  };
}
