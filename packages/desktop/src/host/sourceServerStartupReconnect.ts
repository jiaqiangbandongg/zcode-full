import type { AppSettings } from "@zcode/shared";

/**
 * Host 启动静默重连批次的唯一门禁编排（合同 §8.2）：
 * - `remoteStartupAutoReconnectEnabled === false` 跳过整个启动批次（连候选枚举都不执行）；
 * - `true` 或缺字段（旧设置）都视为开启，保持现行为、不触发迁移；
 * - 该开关只作用于本入口，手动连接与断线 retrying/offline 恢复不读取此设置。
 * 从 host/index.ts 提取为纯编排函数以便单测门禁行为；运行时行为与提取前一致。
 */
export async function runStartupReconnectBatch<TCandidate, TResult>(deps: {
  getSettings: () => Promise<Pick<AppSettings, "remoteStartupAutoReconnectEnabled">>;
  listCandidates: () => Promise<TCandidate[]>;
  reconnect: (candidates: TCandidate[]) => Promise<TResult[]>;
}): Promise<TResult[]> {
  const settings = await deps.getSettings();
  if (settings.remoteStartupAutoReconnectEnabled === false) return [];
  return await deps.reconnect(await deps.listCandidates());
}
