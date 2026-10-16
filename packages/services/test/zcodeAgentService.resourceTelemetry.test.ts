import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaneResourceSample } from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

const RESOURCE_SAMPLE_FAKE_AGENT = `
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
    send({
      method: "process/resourceSample",
      params: {
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60000,
        cpuCores: 1.5,
        cpuPercent: 18.75,
        rssKb: 131072,
        workspacePath: "/must-not-pass",
      },
    });
    send({
      method: "process/resourceSample",
      params: {
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60000,
        cpuCores: 1.5,
        cpuPercent: 18.75,
        rssKb: 131072,
        lane: "chat",
      },
    });
    send({
      method: "process/resourceSample",
      params: {
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60000,
        cpuCores: 1.5,
        cpuPercent: 18.75,
        rssKb: 131072,
      },
    });
    send({
      method: "process/resourceSample",
      params: {
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60000,
        cpuCores: 1.5,
        cpuPercent: 18.75,
        rssKb: 131072,
        heapUsedKb: 20480,
        uptimeMinutes: 12,
        totalMemoryGb: 16,
        instanceToken: "9f2c4a1b7d0e5638",
      },
    });
  }
});
`;

describe("ZCodeAgentService process resource telemetry", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PRT-025 旧格式样本通过校验并分发，新字段透传，lane 由 services 按进程管理器打标", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-resource-telemetry-"));
    tempDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "resource-agent.cjs");
    writeFileSync(scriptPath, RESOURCE_SAMPLE_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });
    const samples: AgentLaneResourceSample[] = [];
    const subscription = service.onDynamicProcessResourceSample()((sample) => {
      samples.push(sample);
    });

    try {
      await service.listSessions({ workspacePath });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const base = {
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60_000,
        cpuCores: 1.5,
        cpuPercent: 18.75,
        rssKb: 131_072,
      } as const;
      // 第一条夹带 workspacePath、第二条自报 lane，两条都被协议层严格拒绝；
      // 通过的两条（旧格式与带新字段）都由 services 补上 chat lane。
      expect(samples).toEqual([
        { ...base, lane: "chat" },
        {
          ...base,
          lane: "chat",
          heapUsedKb: 20_480,
          uptimeMinutes: 12,
          totalMemoryGb: 16,
          instanceToken: "9f2c4a1b7d0e5638",
        },
      ]);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
});
