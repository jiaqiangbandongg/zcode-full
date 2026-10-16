import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAttribution,
  NetworkCaptureService,
  sanitizeHeaders,
} from "../server/network-capture.js";

describe("network capture", () => {
  it("extracts only trace attribution from headers and query parameters", () => {
    const url = new URL(
      "https://api.example.test/v1/chat?session_id=session-query&trace_id=trace-query",
    );

    expect(
      extractAttribution(
        {
          "x-zcode-trace-id": "trace-header",
        },
        url,
      ),
    ).toEqual({
      traceId: "trace-header",
    });
  });

  it("redacts sensitive headers before records reach the UI", () => {
    expect(
      sanitizeHeaders({
        authorization: "Bearer secret",
        cookie: "sid=secret",
        "content-type": "application/json",
      }),
    ).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
      "content-type": "application/json",
    });
  });

  it("captures HTTP proxy requests and keeps trace-linked records", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-network-"));
    const upstream = createServer((incoming, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "debug-secret=1",
      });
      response.end(`ok:${incoming.url ?? "/"}`);
    });
    const upstreamPort = await listen(upstream);
    const service = new NetworkCaptureService({
      host: "127.0.0.1",
      port: 0,
      caDir: join(root, "ca"),
      maxEntries: 5,
    });

    await service.start();
    try {
      const proxyPort = service.getStatus().port;
      expect(proxyPort).toBeGreaterThan(0);
      expect(service.getStatus().env).toEqual({
        ZCODE_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        ZCODE_AGENT_CA_CERT: join(root, "ca", "certs", "ca.pem"),
      });
      await requestThroughProxy(proxyPort ?? 0, upstreamPort);

      const records = await waitForRecords(service, "trace-net");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        traceId: "trace-net",
        method: "POST",
        status: "complete",
        statusCode: 200,
        requestBodyBytes: 3,
      });
      expect(records[0]?.requestHeaders.authorization).toBe("[redacted]");
      expect(records[0]?.responseHeaders["set-cookie"]).toBe("[redacted]");
      expect(service.getStatus().certificate.caCertAvailable).toBe(true);
    } finally {
      await service.stop();
      await close(upstream);
    }
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function requestThroughProxy(proxyPort: number, upstreamPort: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proxied = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "POST",
        path: `http://127.0.0.1:${upstreamPort}/hello`,
        headers: {
          authorization: "Bearer secret",
          "content-type": "text/plain",
          "x-zcode-trace-id": "trace-net",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    proxied.on("error", reject);
    proxied.end("hey");
  });
}

async function waitForRecords(
  service: NetworkCaptureService,
  traceId: string,
): Promise<ReturnType<NetworkCaptureService["listRequests"]>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const records = service.listRequests({ traceId });
    if (records.some((record) => record.status === "complete")) return records;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return service.listRequests({ traceId });
}
