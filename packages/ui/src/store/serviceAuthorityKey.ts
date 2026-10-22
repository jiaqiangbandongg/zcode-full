const serviceAuthorityIds = new WeakMap<object, number>();
let nextServiceAuthorityId = 1;

// Bug 原因：同路径/identity 可以同时存在于 Controller 与多个 Source；只按路径分桶会让
// in-flight Promise 跨 RPC authority 复用。服务实例是 renderer 内最小、稳定的 authority 边界。
export function getServiceAuthorityId(service: object): number {
  const existing = serviceAuthorityIds.get(service);
  if (existing !== undefined) return existing;
  const created = nextServiceAuthorityId++;
  serviceAuthorityIds.set(service, created);
  return created;
}
