import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type AddressInfo } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "@zcode/contracts";
import { createMcpAdapter } from "../src/mcp/index.js";

describe("MCP dual-era version negotiation", () => {
  const cleanupRoots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      Array.from(cleanupRoots, (root) => rm(root, { force: true, recursive: true })),
    );
    cleanupRoots.clear();
  });

  it("negotiates modern by default with a dual-era stdio server", async () => {
    const fixture = await createVersionedServerFixture("dual-era");
    const logCapture = createLogCapture();
    const adapter = createMcpAdapter({ logger: logCapture.logger });

    try {
      await expect(
        adapter.connectServer("modern-default", {
          args: [fixture.serverPath],
          command: process.execPath,
          env: fixture.env,
          timeoutMs: 5_000,
          type: "stdio",
        }),
      ).resolves.toMatchObject({ protocolEra: "modern", status: "connected" });

      await expect(adapter.listTools()).resolves.toEqual([
        expect.objectContaining({ serverName: "modern-default", toolName: "ping" }),
      ]);
      const spawnedPids = await waitForSpawnCount(fixture.spawnLogPath, 2);
      expect(spawnedPids).toHaveLength(2);
      expect(logCapture.entries).toContainEqual({
        context: expect.objectContaining({
          event: "mcp.server.connected",
          mcpProtocolEra: "modern",
          mcpProtocolVersion: "2026-07-28",
          mcpServerName: "modern-default",
          mcpTransportPid: Number(spawnedPids.at(-1)),
          mcpVersionNegotiationMode: "auto",
        }),
        message: "MCP server connected",
      });
    } finally {
      await adapter.close();
    }
  });

  it("falls back to initialize by default with a legacy stdio server", async () => {
    const fixture = await createVersionedServerFixture("legacy");
    const logCapture = createLogCapture();
    const adapter = createMcpAdapter({ logger: logCapture.logger });

    try {
      await expect(
        adapter.connectServer("legacy-default", {
          args: [fixture.serverPath],
          command: process.execPath,
          env: fixture.env,
          timeoutMs: 5_000,
          type: "stdio",
        }),
      ).resolves.toMatchObject({ protocolEra: "legacy", status: "connected" });

      await expect(
        adapter.callTool({ serverName: "legacy-default", toolName: "ping" }),
      ).resolves.toMatchObject({ content: [{ text: "pong", type: "text" }] });
      const spawnedPids = await waitForSpawnCount(fixture.spawnLogPath, 2);
      expect(spawnedPids).toHaveLength(2);
      expect(logCapture.entries).toContainEqual({
        context: expect.objectContaining({
          event: "mcp.server.connected",
          mcpProtocolEra: "legacy",
          mcpProtocolVersion: "2025-11-25",
          mcpServerName: "legacy-default",
          mcpTransportPid: Number(spawnedPids.at(-1)),
          mcpVersionNegotiationMode: "auto",
        }),
        message: "MCP server connected",
      });
    } finally {
      await adapter.close();
    }
  });

  it("maps an HTTP probe negotiation failure (200 + id:null malformed error) to protocol_negotiation_failed", async () => {
    // 飞书项目 MCP 的真实响应形状：对未知方法（server/discover probe）回 HTTP 200 +
    // {"jsonrpc":"2.0","id":null,"error":{"code":-32600,...}}。id:null 过不了 SDK 的
    // JSONRPCMessageSchema，transport 层 schema-parse 失败经 normalizeReply 落入
    // network-error 分支，auto 协商 probe 硬失败（EraNegotiationFailed）。
    // 回归点：adapter 必须把它产出为 protocol_negotiation_failed，而不是默认的
    // network_unreachable（设置页会显示误导性的"网络不可达"）。
    const server = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { code: -32600, message: "invalid request" },
            id: null,
            jsonrpc: "2.0",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const adapter = createMcpAdapter({ logger: createLogCapture().logger });

    try {
      const status = await adapter.connectServer("feishu-legacy-http", {
        timeoutMs: 5_000,
        type: "http",
        url,
      });
      expect(status.status).toBe("failed");
      expect(status.failureKind).toBe("protocol_negotiation_failed");
    } finally {
      await adapter.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function createVersionedServerFixture(mode: "dual-era" | "legacy") {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-version-negotiation-"));
    cleanupRoots.add(root);
    const serverPath = join(root, "server.mjs");
    const spawnLogPath = join(root, "spawns.log");
    const mcpServerModule = import.meta.resolve("@modelcontextprotocol/server");
    const stdioServerTransportModule = import.meta.resolve("@modelcontextprotocol/server/stdio");
    const servingCode =
      mode === "dual-era"
        ? "serveStdio(createServer);"
        : "await createServer().connect(new StdioServerTransport());";

    await writeFile(
      serverPath,
      [
        "import { appendFile } from 'node:fs/promises';",
        `import { McpServer } from ${JSON.stringify(mcpServerModule)};`,
        `import { serveStdio, StdioServerTransport } from ${JSON.stringify(stdioServerTransportModule)};`,
        "await appendFile(process.env.SPAWN_LOG_PATH, `${process.pid}\\n`);",
        "function createServer() {",
        "  const server = new McpServer({ name: 'version-negotiation-test', version: '1.0.0' });",
        "  server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
        "  return server;",
        "}",
        servingCode,
      ].join("\n"),
    );

    return {
      env: { SPAWN_LOG_PATH: spawnLogPath },
      serverPath,
      spawnLogPath,
    };
  }
});

function createLogCapture(): {
  entries: Array<{ context?: Parameters<Logger["info"]>[1]; message: string }>;
  logger: Logger;
} {
  const entries: Array<{ context?: Parameters<Logger["info"]>[1]; message: string }> = [];
  let logger: Logger;
  logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: (message, context) => entries.push({ context, message }),
    warn: () => undefined,
  };
  return { entries, logger };
}

async function waitForSpawnCount(path: string, expectedCount: number): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    try {
      const pids = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
      if (pids.length >= expectedCount) return pids;
    } catch {
      // probe/session child 尚未写入；继续等待。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${expectedCount} MCP server processes`);
}
