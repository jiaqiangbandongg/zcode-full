export interface EnsureSourceServerBoundaryAcknowledgedOptions<TVersion extends number> {
  currentVersion?: TVersion;
  targetVersion: TVersion;
  requestAcknowledgement: () => Promise<boolean>;
  persistVersion: (version: TVersion) => Promise<void>;
  isCurrent?: () => boolean;
}

/**
 * 一期能力边界是 required acknowledgement：只有用户明确确认后才持久化版本。
 * 取消、并发确认冲突或组件卸载都不能伪装成已经阅读。
 */
export async function ensureSourceServerBoundaryAcknowledged<TVersion extends number>(
  options: EnsureSourceServerBoundaryAcknowledgedOptions<TVersion>,
): Promise<boolean> {
  if (options.isCurrent?.() === false || options.currentVersion === options.targetVersion)
    return false;
  if (!(await options.requestAcknowledgement())) return false;
  // 连接/表单取消后，迟到的确认不能替已失效的意图消费首次介绍。
  if (options.isCurrent?.() === false) return false;
  await options.persistVersion(options.targetVersion);
  return true;
}
