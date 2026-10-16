import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryCore } from "#src/telemetry/telemetryCore.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("TelemetryCore final HTTP privacy boundary", () => {
  it("本机 HTTP 接收器实际收到的请求不含登录参数或错误原文", async () => {
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const homeDir = await mkdtemp(join(tmpdir(), "telemetry-privacy-http-"));
      homes.push(homeDir);
      const core = createTelemetryCore({
        homeDir,
        resolveZCodeEndpointOrigin: () => `http://127.0.0.1:${address.port}`,
      });
      const context = { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" };
      await core.reportEvent({
        context,
        elementName: "app_login_ck",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail: {
          login_url: "https://login.example.com/auth?state=FAKE_STATE&token=FAKE_TOKEN",
        },
      });
      await core.reportEvent({
        context,
        elementName: "message_completion",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: {
          error_msg: "Authorization: Bearer FAKE_TOKEN /Users/FAKE_USER/private",
          error_type: "TOOL_EXEC_ERROR",
        },
      });
      expect(received).toHaveLength(2);
      expect(JSON.parse(received[0]!).event_extra_detail).toEqual({
        login_url: "login.example.com",
      });
      expect(JSON.parse(received[1]!).event_extra_detail).toEqual({
        error_msg: "[redacted]",
        error_type: "TOOL_EXEC_ERROR",
      });
      expect(received.join("\n")).not.toMatch(/FAKE_STATE|FAKE_TOKEN|FAKE_USER|Bearer|\/auth/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["agent_step", "message_completion", "automation_create_result", "future_event"])(
    "直接 Core 调用 %s 与重试都不发送错误原文，正常鉴权不变",
    async (elementName) => {
      const homeDir = await mkdtemp(join(tmpdir(), "telemetry-privacy-"));
      homes.push(homeDir);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const core = createTelemetryCore({
        homeDir,
        fetchImpl,
        sleep: async () => {},
        loadAuthorization: async () => "Bearer FAKE_AUTH_HEADER",
      });
      await core.reportEvent({
        context: { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" },
        elementName,
        eventRegion: "app",
        eventType: "result",
        eventExtraDetail: {
          error_msg: "FAKE_BODY_SECRET https://example.com/private /Users/private/key",
          error_code: "E_TEST",
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const request = fetchImpl.mock.calls[0]![1]!;
      expect(JSON.parse(String(request.body)).event_extra_detail).toEqual({
        error_msg: "[redacted]",
        error_code: "E_TEST",
      });
      expect(String(request.body)).not.toContain("FAKE_BODY_SECRET");
      expect(String(request.body)).not.toContain("FAKE_AUTH_HEADER");
      expect(request.headers).toMatchObject({ Authorization: "Bearer FAKE_AUTH_HEADER" });
      expect(fetchImpl.mock.calls[1]![1]!.body).toBe(request.body);
    },
  );

  it.each([
    "https://user:secret@login.example.com:8443/auth?token=secret#state",
    "login.example.com",
  ])("Core 仅发送登录 hostname：%s", async (login_url) => {
    const homeDir = await mkdtemp(join(tmpdir(), "telemetry-privacy-"));
    homes.push(homeDir);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const core = createTelemetryCore({ homeDir, fetchImpl });
    await core.reportEvent({
      context: { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" },
      elementName: "app_login_ck",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: { login_url },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).event_extra_detail).toEqual({
      login_url: "login.example.com",
    });
  });
});
