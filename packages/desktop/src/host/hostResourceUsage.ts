import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

export interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Host 直管的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

export interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * 资源管理器 Host 侧响应器。
 * 只在 main 发来请求时采样一次：读整机进程表 → 向每个本地 Agent 要 MCP 子进程映射 → 按 Host 子树归属 → 回帖。
 * 最多执行一轮，不保存采样队列；关窗取消后不发布迟到结果。
 */
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => undefined),
      options
        .getAgentService()
        ?.collectLocalRuntimeChildProcesses(signal)
        .catch(() => []) ?? Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    options.postMessage({
      type: HostResponseTypes.ResourceUsageSnapshotResult,
      requestId: message.requestId,
      sampledAt: now(),
      processes,
    });
  }

  return {
    async handleRequest(message) {
      let current: typeof active;
      try {
        // Main 展示超时不代表底层结束，不能把每秒查询变成无界 FIFO。
        if (active) {
          options.postMessage({
            type: HostResponseTypes.ResourceUsageSnapshotResult,
            requestId: message.requestId,
            sampledAt: now(),
            processes: [],
          });
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // 观测失败或退出时回帖失败只丢弃本轮，不能以未处理异常影响 Host 生命周期。
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
