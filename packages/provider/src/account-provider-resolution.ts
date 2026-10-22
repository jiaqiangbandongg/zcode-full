import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderId,
} from "./config/index.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

export type AccountProviderConnectionResult = {
  /** 账号/组织身份变化后禁止沿用旧快照；仅用于本轮解析，不进入配置。 */
  readonly resetPrevious?: boolean;
  /** 派生执行入口不拥有独立权益，发布时继承该母体 Provider 的最终权益。 */
  readonly entitlementSourceProviderId?: ProviderId;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** 仅在 status === "unavailable" 时携带；unknown 表示本轮无法判定原因。 */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
    const states: Record<string, AccountProviderState> = {};
    const connectionByProviderId = indexConnections(input.configuredProviders, connections);
    const resolveState = (connection: AccountProviderConnectionResult): AccountProviderState => {
      const existing = states[connection.providerId];
      if (existing) return existing;
      const previous = connection.resetPrevious
        ? undefined
        : input.previousStates?.[connection.providerId];
      const access = providers.get(connection.providerId)?.access;
      const sourceId = connection.entitlementSourceProviderId;
      const sourceConnection = sourceId ? connectionByProviderId.get(sourceId) : undefined;
      // Bug 根因：派生入口曾直接消费母体原始 availability，把 unknown 硬判为无权益；
      // 母体却在这里沿用 last-known-good，导致同轮 Registry 状态分裂。派生状态必须读取母体
      // 应用身份隔离与 last-known-good 后的最终发布事实，不能再维护第二份权益判断。
      const inheritedState = sourceConnection ? resolveState(sourceConnection) : undefined;
      // unknown 仅保留上次展示事实；current 始终来自本轮选择，不能复活旧连接。
      const unavailableReason = inheritedState
        ? inheritedState.unavailableReason
        : connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
      const availability = inheritedState
        ? inheritedState.entitled
          ? "available"
          : "unavailable"
        : connection.status === "unknown" && previous
          ? previous.availability
          : connection.status;
      const state = Object.freeze({
        ...(connection.status === "unknown" && !inheritedState ? previous : {}),
        availability,
        entitled: access?.type === "zhipu-account" && access.entitled === true,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ...(connection.current === undefined ? {} : { current: connection.current }),
        connectionKey: connection.connectionKey,
        ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
      });
      states[connection.providerId] = state;
      return state;
    };
    for (const connection of connections) resolveState(connection);
    return Object.freeze({ providers, states: Object.freeze(states) });
  };
}

/** 把账号连接结果转换为 Registry 使用的第三层 Account Provider Config。 */
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolvedByProviderId = new Map<ProviderId, ProviderConfig>();
  const resolving = new Set<ProviderId>();
  const resolveProvider = (providerId: ProviderId): ProviderConfig | undefined => {
    const existing = resolvedByProviderId.get(providerId);
    if (existing) return existing;
    const configured = input.configuredProviders.get(providerId);
    if (!configured || configured.access?.type !== "zhipu-account") return undefined;
    if (resolving.has(providerId)) {
      throw new Error(`Account Provider 权益继承存在循环: ${providerId}`);
    }
    resolving.add(providerId);
    const connection = connectionByProviderId.get(providerId) ?? {
      providerId,
      status: "unknown" as const,
    };
    let resolved: ProviderConfig;
    if (connection.entitlementSourceProviderId) {
      const source = resolveProvider(connection.entitlementSourceProviderId);
      // 派生入口只继承母体本轮最终 Overlay。母体 unknown 已在上面的普通分支应用
      // last-known-good；母体身份变化时 resetPrevious 会先清掉旧权益，因此这里不会复活旧 Team。
      resolved = createEntitlementOverlay(
        source?.access?.type === "zhipu-account" && source.access.entitled === true,
      );
    } else if (connection.status === "available" || connection.status === "pending") {
      if (configured.access.mode === "start-plan") {
        resolved = new ProviderConfig({
          // 明确空模型是本轮权威结果，不能保留已经失效的旧白名单。
          access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
          builtinModelIds: normalizeModelIds(connection.models),
        });
      } else {
        resolved = createEntitlementOverlay(connection.status === "available");
      }
    } else if (connection.status === "unavailable") {
      resolved = createEntitlementOverlay(false);
    } else {
      resolved =
        (connection.resetPrevious ? undefined : input.previousProviders.get(providerId)) ??
        createEntitlementOverlay(false);
    }
    resolving.delete(providerId);
    resolvedByProviderId.set(providerId, resolved);
    return resolved;
  };

  const resolved: Array<readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId, configured] of input.configuredProviders.entries()) {
    if (configured.access?.type !== "zhipu-account") continue;
    const provider = resolveProvider(providerId);
    if (provider) resolved.push([providerId, provider]);
  }
  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(entitled: boolean): ProviderConfig {
  return new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`重复 Account Provider 连接结果: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(`Account 连接指向未配置 Provider: ${connection.providerId}`);
    }
    if (!isAccountConstrainedProvider(configured)) {
      throw new Error(`Account 连接指向非 Account Provider: ${connection.providerId}`);
    }
    const sourceId = connection.entitlementSourceProviderId;
    if (sourceId === connection.providerId) {
      throw new Error(`Account Provider 不能继承自身权益: ${connection.providerId}`);
    }
    if (sourceId && !configuredProviders.get(sourceId)) {
      throw new Error(`Account Provider 权益母体未配置: ${connection.providerId} -> ${sourceId}`);
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function isAccountConstrainedProvider(config: ProviderConfig): boolean {
  return config.access?.type === "zhipu-account";
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
