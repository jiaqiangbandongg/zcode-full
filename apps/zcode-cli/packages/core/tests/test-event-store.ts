import { InMemorySessionEventStore, type SessionEventStorePort } from "@zcode/contracts";

/**
 * core 测试用的 event store 直接复用 contracts 的生产实现，避免手写替身与生产行为漂移。
 * 这里选 `unbounded`：core 测试关注 runtime 语义，不验证保留策略，保留全部事件便于断言。
 */
export function createTestSessionEventStore(): SessionEventStorePort {
  return new InMemorySessionEventStore({ retention: "unbounded" });
}
