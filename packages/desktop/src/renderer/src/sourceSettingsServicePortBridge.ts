import { createMessagePortServiceConnection } from "@zcode/client";
import { InternalChannels } from "@zcode/shared";
import { registerSourceSettingsServices } from "@zcode/ui";

export function handleSourceSettingsServicePortMessage(event: MessageEvent): boolean {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("type" in event.data) ||
    event.data.type !== InternalChannels.SourceSettingsServicePort
  ) {
    return false;
  }
  const sourceServerId =
    "sourceServerId" in event.data && typeof event.data.sourceServerId === "string"
      ? event.data.sourceServerId
      : "";
  const attachmentId =
    "attachmentId" in event.data && typeof event.data.attachmentId === "string"
      ? event.data.attachmentId
      : "";
  const port = event.ports[0];
  if (!sourceServerId || !attachmentId || !port) {
    port?.close();
    return true;
  }
  const connection = createMessagePortServiceConnection(port);
  const release = registerSourceSettingsServices({
    sourceServerId,
    attachmentId,
    services: connection.services,
    dispose: connection.dispose,
  });
  port.addEventListener("close", release, { once: true });
  return true;
}
