import { describe, expect, it, vi } from "vitest";

describe("host transferred MessagePort rejection cleanup", () => {
  it("schema invalid 与 attach-too-early 都立即 close transferred port", async () => {
    const modulePromise = import("../src/host/hostMessagePortGuard.js");
    await expect(modulePromise).resolves.toBeDefined();
    const { parseHostIncomingMessageEvent, rejectUnavailableAttachedServicePort } =
      await modulePromise;

    const invalidPort = { close: vi.fn() };
    const secondInvalidPort = { close: vi.fn() };
    const invalid = parseHostIncomingMessageEvent({
      data: {
        type: "attach-service-port",
        attachmentId: "attachment-1",
        clientMode: "desktop-continuous",
        forged: true,
      },
      ports: [invalidPort, secondInvalidPort],
    });
    expect(invalid.success).toBe(false);
    expect(invalidPort.close).toHaveBeenCalledOnce();
    expect(secondInvalidPort.close).toHaveBeenCalledOnce();

    const earlyPort = { close: vi.fn() };
    expect(rejectUnavailableAttachedServicePort(earlyPort, false)).toBe(true);
    expect(earlyPort.close).toHaveBeenCalledOnce();

    const readyPort = { close: vi.fn() };
    expect(rejectUnavailableAttachedServicePort(readyPort, true)).toBe(false);
    expect(readyPort.close).not.toHaveBeenCalled();
  });

  it("application-locale-changed 只接受合法界面语言", async () => {
    const { parseHostIncomingMessageEvent } = await import("../src/host/hostMessagePortGuard.js");

    const valid = parseHostIncomingMessageEvent({
      data: { type: "application-locale-changed", locale: "zh-CN" },
      ports: [],
    });
    expect(valid.success && valid.data).toEqual({
      type: "application-locale-changed",
      locale: "zh-CN",
    });
    expect(
      parseHostIncomingMessageEvent({
        data: { type: "application-locale-changed", locale: "fr-FR" },
        ports: [],
      }).success,
    ).toBe(false);
  });
});
