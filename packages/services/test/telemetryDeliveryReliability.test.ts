import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-delivery-"));
  tempHomes.push(home);
  return home;
}

async function waitForCalls(
  mock: ReturnType<typeof vi.fn<typeof fetch>>,
  expectedCalls: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length === expectedCalls) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(mock).toHaveBeenCalledTimes(expectedCalls);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("telemetry delivery reliability", () => {
  it("retries a network failure once with the identical endpoint, body, and event_id", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => {});
    const resolveZCodeEndpointOrigin = vi.fn(async () => "https://telemetry.example.com");
    const ids = ["logical-event-id", "stable-device-mid"];
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => ids.shift() ?? "unexpected-id",
      resolveZCodeEndpointOrigin,
      sleep,
    });

    await service.reportEvent({
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "1920x1080",
      },
      elementName: "off_peak_task_create_result",
      eventRegion: "app.automations",
      eventType: "result",
      eventExtraDetail: { off_peak_task_id: "OP-1" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      event_id: "logical-event-id",
    });
    expect(resolveZCodeEndpointOrigin).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it.each([
    { status: 408, delayMs: 300 },
    { status: 429, delayMs: 1_000 },
    { status: 500, delayMs: 300 },
  ])("retries HTTP $status once", async ({ status, delayMs }) => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => {});
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => "retryable-event-id",
      sleep,
    });

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "1920x1080",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(delayMs);
  });

  it.each([400, 401])("does not retry permanent HTTP %s", async (status) => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    const sleep = vi.fn(async () => {});
    const warn = vi.fn();
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => "permanent-event-id",
      sleep,
      warn,
    });

    await expect(
      service.reportAppLaunch({
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "1920x1080",
      }),
    ).rejects.toThrow(String(status));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging attempt and retries once", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => {});
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => "timeout-event-id",
      requestTimeoutMs: 5,
      sleep,
    });

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "1920x1080",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it("logs one redacted final warning after both attempts fail", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("secret C:\\Users\\private\\token.txt"));
    const warn = vi.fn();
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => "redacted-event-id",
      sleep: async () => {},
      warn,
    });

    await expect(
      service.reportEvent({
        context: {
          clientTimezone: "Asia/Shanghai",
          clientLanguage: "zh-CN",
          screenResolution: "1920x1080",
        },
        elementName: "off_peak_task_create_result",
        eventRegion: "app.automations",
        eventType: "result",
        eventExtraDetail: {},
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("event=off_peak_task_create_result");
    expect(warning).toContain("eventId=redacted-event-id");
    expect(warning).toContain("attempts=2");
    expect(warning).not.toContain("Users");
    expect(warning).not.toContain("token.txt");
  });

  it("flushes reports added while an app-quit drain is already waiting", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(new Response(null, { status: 204 })));
        }),
    );
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => `dynamic-${fetchMock.mock.calls.length}`,
    });
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "1920x1080",
    };

    const firstReport = service.reportAppLaunch(context);
    await waitForCalls(fetchMock, 1);
    let flushed = false;
    const flush = service.flushPendingReports({ timeoutMs: 1_000 }).then(() => {
      flushed = true;
    });
    const secondReport = service.reportAppLaunch(context);
    await waitForCalls(fetchMock, 2);

    releases[0]?.();
    await firstReport;
    await Promise.resolve();
    expect(flushed).toBe(false);

    releases[1]?.();
    await Promise.all([secondReport, flush]);
    expect(flushed).toBe(true);
  });

  it("stops waiting for pending reports when the flush deadline expires", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    let releaseFetch: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () => resolve(new Response(null, { status: 204 }));
        }),
    );
    const warn = vi.fn();
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      randomUUID: () => "flush-timeout-event-id",
      requestTimeoutMs: 1_000,
      warn,
    });

    const report = service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "1920x1080",
    });
    await waitForCalls(fetchMock, 1);
    await service.flushPendingReports({ timeoutMs: 5 });

    expect(warn).toHaveBeenCalledWith("Telemetry flush timed out; pending=1");
    releaseFetch?.();
    await report;
  });
});

describe("session_create 稳定事件身份", () => {
  it("同用户/session 跨 core 和 HTTP 重试同 ID，不同用户或 session 不碰撞", async () => {
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const home = makeTempHome();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const input = {
      context: { clientTimezone: "UTC", clientLanguage: "en", screenResolution: "" },
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      eventExtraDetail: { create_source: "project" },
      talkId: "sess-1",
      messageId: "input-1",
      userId: "user-1",
    };
    const core = () =>
      createTelemetryCore({ fetchImpl: fetchMock, homeDir: home, sleep: async () => {} });
    await core().reportEvent(input);
    await core().reportEvent({
      ...input,
      messageId: "input-2",
      eventExtraDetail: { create_source: "session" },
    });
    await core().reportEvent({ ...input, talkId: "sess-2" });
    await core().reportEvent({ ...input, userId: "user-2" });
    const ids = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).event_id);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(new Set([ids[0], ids[3], ids[4]]).size).toBe(3);
  });
});
