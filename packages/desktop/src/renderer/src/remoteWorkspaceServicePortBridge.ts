import {
  InternalChannels,
  scopedServicePortPayloadSchema,
  type ScopedServicePortPayload,
} from "@zcode/shared";

export type RemoteWorkspaceServicePortRegistration = ScopedServicePortPayload & {
  port: MessagePort;
};

export function parseRemoteWorkspaceServicePortMessage(
  event: MessageEvent,
): RemoteWorkspaceServicePortRegistration | null {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("type" in event.data) ||
    event.data.type !== InternalChannels.ScopedServicePort
  ) {
    return null;
  }
  const port = event.ports[0];
  const { type: _type, ...payload } = event.data;
  const parsed = scopedServicePortPayloadSchema.safeParse(payload);
  if (!port || !parsed.success) return null;
  return {
    ...parsed.data,
    port,
  };
}

export function notifyRemoteWorkspaceServicePortReady(
  payload: Pick<
    RemoteWorkspaceServicePortRegistration,
    "attachmentId" | "sessionId"
  >,
  postMessage: (
    message: unknown,
    targetOrigin: string,
  ) => void = window.postMessage.bind(window),
): void {
  postMessage(
    {
      type: InternalChannels.ScopedServicePortReady,
      attachmentId: payload.attachmentId,
      sessionId: payload.sessionId,
    },
    "*",
  );
}
