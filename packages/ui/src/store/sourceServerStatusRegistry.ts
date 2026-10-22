import type { ISourceServerManagementService } from "@zcode/services";
import {
  buildAggregatedSourceStatusMap,
  type AggregatedSourceStatus,
  getRemoteDevicePresentationInput,
  type RemoteConnectionPresentationInput,
} from "@/lib/remoteConnectionPresentation.js";

export interface SourceServerStatusRegistry {
  subscribe(listener: () => void): () => void;
  getInputs(): ReadonlyMap<string, RemoteConnectionPresentationInput>;
  getSnapshot(): ReadonlyMap<string, AggregatedSourceStatus>;
}

const registries = new WeakMap<ISourceServerManagementService, SourceServerStatusRegistry>();

export function getSourceServerStatusRegistry(
  management: ISourceServerManagementService,
): SourceServerStatusRegistry {
  const existing = registries.get(management);
  if (existing) return existing;

  let statuses: ReadonlyMap<string, AggregatedSourceStatus> = new Map();
  let inputs: ReadonlyMap<string, RemoteConnectionPresentationInput> = new Map();
  const listeners = new Set<() => void>();
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  const notify = () => listeners.forEach((listener) => listener());
  const refresh = () => {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = management
      .getSnapshot()
      .then((snapshot) => {
        statuses = buildAggregatedSourceStatusMap(snapshot);
        inputs = new Map(
          snapshot.servers.map((server) => [
            server.sourceServerId,
            getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
          ]),
        );
        notify();
      })
      .catch(() => undefined)
      .finally(() => {
        refreshInFlight = null;
        if (refreshQueued) {
          refreshQueued = false;
          refresh();
        }
      });
  };
  const stateSubscription = management.onDidChangeState(() => refresh());
  const directorySubscription = management.onDidChangeDirectory?.(() => refresh());
  const registry: SourceServerStatusRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => statuses,
    getInputs: () => inputs,
  };
  registries.set(management, registry);
  refresh();
  // Registry lifetime follows the management service; the service owns disposal of its event.
  void stateSubscription;
  void directorySubscription;
  return registry;
}
