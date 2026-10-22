import { useSyncExternalStore } from "react";
import type { IServiceAccessor } from "@zcode/services";

interface SourceSettingsServicesEntry {
  attachmentId: string;
  services: IServiceAccessor;
  dispose: () => void;
}

interface RegisterSourceSettingsServicesParams extends SourceSettingsServicesEntry {
  sourceServerId: string;
}

const servicesBySourceServerId = new Map<string, SourceSettingsServicesEntry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function registerSourceSettingsServices(
  params: RegisterSourceSettingsServicesParams,
): () => void {
  const { sourceServerId } = params;
  const entry: SourceSettingsServicesEntry = {
    attachmentId: params.attachmentId,
    services: params.services,
    dispose: params.dispose,
  };
  const previous = servicesBySourceServerId.get(sourceServerId);
  servicesBySourceServerId.set(sourceServerId, entry);
  previous?.dispose();
  emit();
  return () => {
    // Bug 原因：旧 attachment 的 close 可能晚于新一代注册；只按 Source 删除会误删当前服务。
    if (servicesBySourceServerId.get(sourceServerId) !== entry) return;
    servicesBySourceServerId.delete(sourceServerId);
    entry.dispose();
    emit();
  };
}

export function getSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return sourceServerId ? servicesBySourceServerId.get(sourceServerId)?.services : undefined;
}

export function useSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSourceSettingsServices(sourceServerId),
    () => undefined,
  );
}

// 同一 Source 的配置面板共享一次 attachment admission，不复制物理连接或业务状态。
const attachmentRequests = new Map<string, Promise<void>>();
export function ensureSourceSettingsServices(
  sourceServerId: string,
  request: (id: string) => Promise<{ attachmentId: string }>,
): Promise<void> {
  if (getSourceSettingsServices(sourceServerId)) return Promise.resolve();
  const pending = attachmentRequests.get(sourceServerId);
  if (pending) return pending;
  const result = request(sourceServerId)
    .then(() => undefined)
    .finally(() => {
      if (attachmentRequests.get(sourceServerId) === result)
        attachmentRequests.delete(sourceServerId);
    });
  attachmentRequests.set(sourceServerId, result);
  return result;
}
