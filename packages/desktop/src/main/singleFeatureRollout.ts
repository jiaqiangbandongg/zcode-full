/**
 * 单功能灰度 rollout 的通用机制层：TTL 缓存、in-flight 去重、3s 请求超时、
 * awaitFirstDecision 有界裁决。解析层（每个 feature 各自的 resolveConfig）由调用方注入。
 *
 * 抽取原因：desktopContextPromptRollout 与 rendererActionTraceRollout 共享同一套
 * /api/v1/client/configs 旁路请求机制，只有 `data.configs.<key>` 的解析不同；复制两份
 * 170 行机制代码会让超时/TTL 语义悄悄分叉。
 *
 * 语义约定（与 desktopContextPromptRollout 一致，CUA 灰度 fail-close 也复用同一语义）：
 * - 请求失败/超时/解析失败：沿用上次快照（首次即失败 → 初始快照，由 defaultValue 决定）；
 * - 服务端成功但未下发该 key：视为"未启用"，覆盖旧缓存（不能继续沿用旧的开启快照）。
 */
export interface SingleFeatureRolloutConfig {
  enabled: boolean;
  configVersion?: string;
}

export interface SingleFeatureRollout<T extends SingleFeatureRolloutConfig> {
  refresh(): Promise<T>;
  getSnapshot(): T;
  /**
   * 有界等待一次灰度裁决：与服务端请求 race，超时则回退当前快照。
   *
   * 设计原因：Host/Agent 的 presentation surface 在进程启动时冻结（services/node.ts 顶层
   * const + CLI --surface），而灰度请求是旁路、不阻塞 Host。若首个 Host fork 早于请求
   * resolve，成功结果对已冻结的 Host/Agent 无可达生效路径。该方法给"成功结果"
   * 一条有界的生效路径：调用方在首个 Host fork 前 await 它，拿到真值后再让 spawn 流程
   * 同步读取快照。本身无状态——first-only latch 由调用方（desktop main）持有。
   */
  awaitFirstDecision(timeoutMs: number): Promise<T>;
}

export interface SingleFeatureRolloutLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export const SINGLE_FEATURE_REQUEST_TIMEOUT_MS = 3_000;
export const SINGLE_FEATURE_CACHE_TTL_MS = 60 * 60 * 1_000;

export interface CreateSingleFeatureRolloutOptions<T extends SingleFeatureRolloutConfig> {
  /** 解析 /api/v1/client/configs 响应体；null 表示响应无效（按失败处理，沿用旧快照）。 */
  resolveConfig: (payload: unknown) => T | null;
  /** 初始快照（fail-open feature 传 {enabled:true}，fail-close 传 {enabled:false}）。 */
  defaultValue: T;
  /** 日志前缀，如 "desktop-context-prompt" / "renderer-action-trace"。 */
  logTag: string;
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: SingleFeatureRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export function createSingleFeatureRollout<T extends SingleFeatureRolloutConfig>(
  options: CreateSingleFeatureRolloutOptions<T>,
): SingleFeatureRollout<T> {
  let snapshot: T = options.defaultValue;
  let snapshotExpiresAt = 0;
  let inFlight: Promise<T> | undefined;
  const timeoutMs = Math.max(options.timeoutMs ?? SINGLE_FEATURE_REQUEST_TIMEOUT_MS, 1);
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? SINGLE_FEATURE_CACHE_TTL_MS, 1);

  const refresh = (): Promise<T> => {
    if (Date.now() < snapshotExpiresAt) {
      return Promise.resolve(snapshot);
    }
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${options.logTag} config timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        });
        const payload = await Promise.race([
          options.fetchConfig(controller.signal),
          timeoutPromise,
        ]);
        const next = options.resolveConfig(payload);
        if (!next) {
          throw new Error(`${options.logTag} config is invalid`);
        }
        snapshot = next;
        snapshotExpiresAt = Date.now() + cacheTtlMs;
        options.logger.info?.(`[${options.logTag}] config refreshed`, {
          enabled: next.enabled,
          configVersion: next.configVersion,
        });
        return snapshot;
      } catch (error) {
        // 灰度配置是旁路能力：服务端异常或超时不能阻塞客户端；有成功结果时沿用，首次失败回退默认。
        options.logger.warn(`[${options.logTag}] config unavailable, using cached decision`, {
          error,
          enabled: snapshot.enabled,
        });
        return snapshot;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        controller.abort();
      }
    })();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
    );
    return request;
  };

  return {
    refresh,
    getSnapshot: () => snapshot,
    awaitFirstDecision: (timeoutMs: number) => {
      // 与 refresh() race：refresh 内部已有 TTL/inFlight 去重 + 3s 请求超时，且永不 reject
      // （异常时返回上次快照）；外层 timeout 到点回退当前 snapshot。两支均 resolve，
      // 保证调用方（首个 Host fork 路径）永远不会被 reject 阻塞。
      const boundedTimeout = Math.max(timeoutMs, 1);
      const fallback = new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(snapshot), boundedTimeout);
        // 旁路计时器不能阻止进程退出（测试/关机场景）。
        timer.unref?.();
      });
      return Promise.race([refresh(), fallback]);
    },
  };
}
