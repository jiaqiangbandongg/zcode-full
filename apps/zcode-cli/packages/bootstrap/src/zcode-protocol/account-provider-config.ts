import {
  zcodeProviderRefreshRegistryParamsSchema,
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ZCodeProviderRefreshRegistryResult,
  type ZCodeProviderUpdateAccountConfigResult,
} from "@zcode/shared";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 更新进程级 Account Provider Config。
 *
 * 该协议传 Account Overlay 与对应状态；API Key、JWT 和动态 Header 由请求期鉴权协议处理。
 */
export async function updateAccountProviderConfig(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderUpdateAccountConfigResult> {
  const envelope = parseParams(zcodeProviderUpdateAccountConfigParamsSchema, params);
  const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
  };
}

/**
 * 让当前 Worker 重新读取自己的 Personal/Account Config Store。
 *
 * 该请求只触发 Worker 本地刷新，不接收 Desktop Registry 快照，避免把远端 Environment
 * 的 Provider 权威重新下沉到 Host。执行入口在 ACK 前调用它，封住 Provisioning 后存量
 * Worker 仍持有旧 Registry 的窗口。
 */
export async function refreshProviderRegistry(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderRefreshRegistryResult> {
  const envelope = zcodeProviderRefreshRegistryParamsSchema.parse(params);
  if (!context.deps.refreshProviderRegistry) {
    throw new ProtocolRequestError(-32019, "Provider Registry refresh is not configured");
  }
  await context.deps.refreshProviderRegistry(envelope.reason);
  return { refreshed: true };
}
