// @vitest-environment jsdom
import { InternalChannels } from "@zcode/shared";
import { getSourceSettingsServices } from "@zcode/ui";
import { describe, expect, it, vi } from "vitest";
import { handleSourceSettingsServicePortMessage } from "../src/renderer/src/sourceSettingsServicePortBridge.js";

function createPortEvent(params: {
  attachmentId: string;
  sourceServerId: string;
  port: MessagePort;
}): MessageEvent {
  return {
    data: {
      type: InternalChannels.SourceSettingsServicePort,
      attachmentId: params.attachmentId,
      sourceServerId: params.sourceServerId,
    },
    ports: [params.port],
  } as unknown as MessageEvent;
}

describe("sourceSettingsServicePortBridge", () => {
  it("keeps Port B registered when Port A closes after the replacement", async () => {
    const sourceServerId = "source-late-close";
    const portA = new MessageChannel();
    const portB = new MessageChannel();

    handleSourceSettingsServicePortMessage(
      createPortEvent({
        attachmentId: "attachment-a",
        sourceServerId,
        port: portA.port1,
      }),
    );
    const servicesA = getSourceSettingsServices(sourceServerId);
    handleSourceSettingsServicePortMessage(
      createPortEvent({
        attachmentId: "attachment-b",
        sourceServerId,
        port: portB.port1,
      }),
    );
    const servicesB = getSourceSettingsServices(sourceServerId);

    portA.port2.close();

    await vi.waitFor(() => expect(getSourceSettingsServices(sourceServerId)).toBe(servicesB));
    expect(servicesB).toBeDefined();
    expect(servicesB).not.toBe(servicesA);

    portB.port2.close();
    await vi.waitFor(() => expect(getSourceSettingsServices(sourceServerId)).toBeUndefined());
  });
});
