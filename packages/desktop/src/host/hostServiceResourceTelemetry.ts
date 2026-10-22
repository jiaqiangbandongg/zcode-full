import { registerHostToolExecResourceTelemetry } from "./hostToolExecResourceTelemetry.js";
import { registerHostMcpResourceTelemetry } from "./hostMcpResourceTelemetry.js";
import type { IDisposable } from "@zcode/rpc";
import { IZCodeAgentService, type ServiceCollection } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { registerHostAgentResourceTelemetry } from "./hostAgentResourceTelemetry.js";
import { registerHostMcpTelemetry } from "./hostMcpTelemetry.js";

interface RegisterHostServiceResourceTelemetryOptions {
  services: Pick<ServiceCollection, "getOptional">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** 本地默认支持；所有远端须按 server-info 能力声明显式传入。 */
  telemetrySupported?: boolean;
  /** Host 已哈希的运行环境身份，仅透传给 main 的资源分组，不进入 ARMS。 */
  environmentKey?: string;
  onError?(error: unknown): void;
}

const NO_TELEMETRY: IDisposable = { dispose() {} };

function disposeAll(registrations: IDisposable[]): void {
  while (registrations.length > 0) {
    try {
      registrations.pop()?.dispose();
    } catch {
      // 单个订阅释放失败不能拦住其余订阅，否则连接关闭时会残留监听器。
    }
  }
}

/**
 * 一份 service collection 的资源遥测订阅。转发 CLI 自采资源样本、MCP 进程树资源样本，
 * Bash 慢命令完成事实与 MCP 生命周期遥测。
 *
 * local host services 与每个远端 workspace 连接各自调用一次，`runtimeSurface` 由调用方给出：
 * 本机 CLI 是 local，远端 zcode-server 上的 CLI 是 remote，样本自报的硬件维度由 main 覆盖全局默认值。
 * 订阅寿命等于该 collection 的寿命，远端连接释放时由 handle 调用 `dispose()`，不留监听器。
 * 同一台远端机器有多条 dedicated 连接时会有多份订阅；main 按环境与实例归并 CLI/MCP
 * 最近读数，Bash 完成事实由 main 按 completionToken 去重，避免多连接或多窗口重复计数。
 *
 * attachment（桌面 renderer / 手机远控）不是这里的入口：attachment 只复用已就绪的 collection，
 * 这些事件在 Agent connection scope 被限制为 trusted host relay，不进入会话消息面。
 */
export function registerHostServiceResourceTelemetry(
  options: RegisterHostServiceResourceTelemetryOptions,
): IDisposable {
  // 旧 Server 的未知事件异常发生在对端异步读循环，下面的本地 try/catch 无法保护它；
  // 因此缺能力时必须在获取服务、发送任何 EventListen 之前退出。
  if (options.telemetrySupported === false) {
    return NO_TELEMETRY;
  }
  const agentService = options.services.getOptional(IZCodeAgentService);
  if (!agentService) {
    return NO_TELEMETRY;
  }
  const registrations: IDisposable[] = [];
  try {
    registrations.push(
      registerHostAgentResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostMcpTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
    registrations.push(
      registerHostMcpResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostToolExecResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
  } catch (error) {
    // 遥测订阅失败不能改变 Host 服务初始化或远程连接结果，也不能留下半条链路。
    disposeAll(registrations);
    options.onError?.(error);
    return NO_TELEMETRY;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAll(registrations);
    },
  };
}
