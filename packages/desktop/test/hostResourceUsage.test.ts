import { describe, expect, it, vi } from "vitest";
import type { ProcessResourceSample } from "@zcode/services/node";
import { createHostResourceUsageResponder } from "../src/host/hostResourceUsage.js";

function sample(pid: number, ppid: number, command: string): [number, ProcessResourceSample] {
  return [pid, { pid, ppid, rssKb: 100, cpuPercent: 2, command }];
}

describe("hostResourceUsage", () => {
  it("采样 + CLI 映射后按 requestId 回帖归属结果", async () => {
    const postMessage = vi.fn();
    const responder = createHostResourceUsageResponder({
      hostPid: 60,
      now: () => 1_000,
      postMessage,
      sampler: {
        sample: async () =>
          new Map([
            sample(100, 60, "/Applications/ZCode.app/Contents/MacOS/ZCode"),
            sample(120, 100, "node"),
          ]),
      },
      getAgentService: () => ({
        collectLocalRuntimeChildProcesses: async () => [
          {
            pid: 100,
            provider: "glm",
            workspacePath: "/Users/me/demo",
            children: [
              {
                pid: 120,
                serverName: "node_repl",
                mcpSource: "builtin" as const,
                pluginName: "browser-use",
              },
            ],
          },
        ],
      }),
    });

    await responder.handleRequest({ type: "resource-usage-snapshot-request", requestId: "r1" });

    expect(postMessage).toHaveBeenCalledWith({
      type: "resource-usage-snapshot-result",
      requestId: "r1",
      sampledAt: 1_000,
      processes: [
        expect.objectContaining({
          pid: 100,
          category: "base",
          groupKey: "cli",
          name: "zcode-agent-glm-demo",
        }),
        expect.objectContaining({
          pid: 120,
          category: "builtin-plugin",
          groupLabel: "browser-use",
          name: "node_repl",
        }),
      ],
    });
  });

  it("进程表读取失败或 Agent 服务缺失时仍回空结果，不抛错", async () => {
    const postMessage = vi.fn();
    const responder = createHostResourceUsageResponder({
      hostPid: 60,
      now: () => 5,
      postMessage,
      sampler: { sample: async () => undefined },
      getAgentService: () => undefined,
    });
    await responder.handleRequest({ type: "resource-usage-snapshot-request", requestId: "r2" });
    expect(postMessage).toHaveBeenCalledWith({
      type: "resource-usage-snapshot-result",
      requestId: "r2",
      sampledAt: 5,
      processes: [],
    });
  });

  it("采样回帖失败不会变成 Host 未处理异常，也不会卡住后续采样", async () => {
    const postMessage = vi.fn().mockImplementationOnce(() => {
      throw new Error("port closed");
    });
    const responder = createHostResourceUsageResponder({
      hostPid: 60,
      postMessage,
      sampler: { sample: async () => new Map() },
      getAgentService: () => undefined,
    });
    await expect(
      responder.handleRequest({ type: "resource-usage-snapshot-request", requestId: "r1" }),
    ).resolves.toBeUndefined();
    await responder.handleRequest({ type: "resource-usage-snapshot-request", requestId: "r2" });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("慢采样不排队，取消后不投递结果或补执行请求", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const sample = vi.fn(async (currentSignal?: AbortSignal) => {
      signal = currentSignal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Map();
    });
    const responder = createHostResourceUsageResponder({
      hostPid: 60,
      postMessage: (message) => order.push(message.requestId),
      sampler: {
        sample,
      },
      getAgentService: () => undefined,
    });
    const first = responder.handleRequest({
      type: "resource-usage-snapshot-request",
      requestId: "a",
    });
    const second = responder.handleRequest({
      type: "resource-usage-snapshot-request",
      requestId: "b",
    });
    await second;
    expect(sample).toHaveBeenCalledTimes(1);
    responder.cancelRequest("a");
    expect(signal?.aborted).toBe(true);
    release?.();
    await first;
    expect(order).toEqual(["b"]);
    expect(sample).toHaveBeenCalledTimes(1);
  });
});
