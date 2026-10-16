import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZCodeMcpTelemetryEvent, ZCodeMcpResourceSample } from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

const MCP_TELEMETRY_FAKE_AGENT = `
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method !== "session/list" || message.id === undefined) continue;
    send({ id: message.id, result: { sessions: [] } });
    const event = {
      kind: "memory",
      arch: "x64",
      platform: "linux",
      occurredAt: 1000,
      mcpId: "custom:123456789abc",
      mcpInstanceId: "mcp-instance-1",
      mcpIsolation: "session",
      mcpSource: "custom",
      memoryKb: 65536,
      memoryScope: "process_tree",
      ownerSessionCount: 0,
      unownedSeconds: 61,
      orphanSuspected: true,
    };
    send({ method: "process/mcpTelemetry", params: { ...event, mcpServerName: "private" } });
    send({ method: "process/mcpTelemetry", params: event });
    const samples = [{ mcpId: "builtin:node_repl", instanceToken: "cli-instance-01", sampledAt: 300000,
      intervalMs: 300000, processCount: 2, rssKbTotal: 120000, rssKbMaxProcess: 80000,
      cpuTimeMsDelta: 30000, uptimeMinutes: 5, platform: "linux", arch: "x64", logicalCpuCount: 8, totalMemoryGb: 32 }];
    send({ method: "process/mcpResourceSamples", params: [{ ...samples[0], pid: 123 }] });
    send({ method: "process/mcpResourceSamples", params: samples });
  }
});
`;

describe("ZCodeAgentService MCP telemetry", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("strictly validates MCP telemetry before publishing the process-level event", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-mcp-telemetry-"));
    tempDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-telemetry-agent.cjs");
    writeFileSync(scriptPath, MCP_TELEMETRY_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });
    const events: ZCodeMcpTelemetryEvent[] = [];
    const subscription = service.onDynamicMcpTelemetry()((event) => events.push(event));

    try {
      await service.listSessions({ workspacePath });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(events).toEqual([
        {
          arch: "x64",
          kind: "memory",
          mcpId: "custom:123456789abc",
          mcpInstanceId: "mcp-instance-1",
          mcpIsolation: "session",
          mcpSource: "custom",
          memoryKb: 65_536,
          memoryScope: "process_tree",
          occurredAt: 1_000,
          orphanSuspected: true,
          ownerSessionCount: 0,
          platform: "linux",
          unownedSeconds: 61,
        },
      ]);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
  it("通过真实 stdio 解析资源数组，丢弃含 PID 的通知", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-mcp-resources-"));
    tempDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "agent.cjs");
    writeFileSync(scriptPath, MCP_TELEMETRY_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });
    const batches: ZCodeMcpResourceSample[][] = [];
    const subscription = service.onDynamicMcpResourceSamples()((samples) => batches.push(samples));
    try {
      await service.listSessions({ workspacePath });
      await expect.poll(() => batches.length).toBe(1);
      expect(batches[0]).toEqual([
        expect.objectContaining({
          mcpId: "builtin:node_repl",
          rssKbTotal: 120000,
          cpuTimeMsDelta: 30000,
        }),
      ]);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
});
