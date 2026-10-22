import { parseRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type {
  BotProjectConnection,
  BotProjectRuntimePort,
  BotRemoteRuntimeService,
  BotRemoteTarget,
  BotRuntimeSubscription,
  IZCodeTaskService,
} from "#src/bot-project-runtime/contract.js";
export type {
  BotRemoteRuntimeService,
  BotProjectRuntimePort,
  BotProjectConnection,
} from "#src/bot-project-runtime/contract.js";

type Lease = { hostId: string; membershipId: string; connection: BotProjectConnection };

export function createBotProjectRuntime(port: BotProjectRuntimePort): BotRemoteRuntimeService {
  async function readHost(target: BotRemoteTarget) {
    const parsed = parseRemoteWorkspaceIdentity(target.workspaceIdentity);
    if (!parsed || parsed.workspacePath !== target.workspacePath)
      throw new Error("Bot workspace identity/path mismatch");
    const directory = await port.remoteProjectService.readDirectory();
    const identityHost = remoteHostIdFromWorkspaceIdentity(target.workspaceIdentity);
    if (target.hostId && parsed.sourceServerId && target.hostId !== identityHost)
      throw new Error("Bot host/identity mismatch");
    const legacyHost = directory.entries.find(
      (entry) =>
        entry.legacyWorkspace?.workspaceIdentity === target.workspaceIdentity &&
        entry.legacyWorkspace.workspacePath === target.workspacePath,
    )?.hostId;
    return directory.hosts.find(
      (host) => host.id === (target.hostId ?? legacyHost ?? identityHost),
    );
  }

  async function assertLease(target: BotRemoteTarget, lease: Lease): Promise<void> {
    const host = await readHost(target);
    if (
      host?.id !== lease.hostId ||
      host.membershipId !== lease.membershipId ||
      port.resolveOnline(lease.hostId)?.owner !== lease.connection.owner
    )
      throw new Error("Bot Source connection changed during admission");
  }

  async function admit(target: BotRemoteTarget): Promise<Lease> {
    const host = await readHost(target);
    const connection = host ? port.resolveOnline(host.id) : undefined;
    if (!host || !connection) throw new Error("Bot Source is offline or removed");
    const lease = { hostId: host.id, membershipId: host.membershipId, connection };
    await connection.bindWorkspace(target);
    await assertLease(target, lease);
    return lease;
  }

  function subscribe(
    target: BotRemoteTarget,
    initial: Lease,
    params: Parameters<IZCodeTaskService["onDynamicTaskEvent"]>[0],
    receive: Parameters<ReturnType<IZCodeTaskService["onDynamicTaskEvent"]>>[0],
  ): BotRuntimeSubscription {
    if (
      params.workspacePath !== target.workspacePath ||
      params.workspaceIdentity !== target.workspaceIdentity ||
      params.deliveryKind !== "bot-channel-continuous"
    )
      throw new Error("Bot stream scope/delivery mismatch");
    let disposed = false;
    let generation = 0;
    let owner: object | undefined;
    let subscription: BotRuntimeSubscription | undefined;
    const attach = (lease: Lease) => {
      owner = lease.connection.owner;
      subscription = lease.connection.taskService.onDynamicTaskEvent(params)((event) => {
        // 只转发当前物理 owner 的未来事件；不缓存、不补发手机 replayable 内容。
        if (
          !disposed &&
          owner === lease.connection.owner &&
          port.resolveOnline(lease.hostId)?.owner === owner
        )
          return receive(event);
      });
    };
    attach(initial);
    const changed = port.onConnectionsChanged(() => {
      if (disposed || port.resolveOnline(initial.hostId)?.owner === owner) return;
      const currentGeneration = ++generation;
      subscription?.dispose();
      subscription = undefined;
      owner = undefined;
      if (!port.resolveOnline(initial.hostId)) return;
      void admit(target)
        .then((lease) => {
          if (!disposed && generation === currentGeneration) attach(lease);
        })
        .catch((error: unknown) => {
          if (!disposed && generation === currentGeneration)
            port.warn(
              `Bot live subscription unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    });
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        changed.dispose();
        subscription?.dispose();
      },
    };
  }

  const service: BotRemoteRuntimeService = {
    async isConnected(target) {
      const host = await readHost(target);
      return Boolean(host && port.resolveOnline(host.id));
    },
    async ensureConnected(target) {
      const host = await readHost(target);
      if (!host) return { ok: false, message: "Bot Source connection has been removed" };
      try {
        await port.remoteProjectService.connectHost(host.id);
        const current = await readHost(target);
        if (current?.membershipId !== host.membershipId || !port.resolveOnline(host.id))
          throw new Error("Bot Source connection changed during reconnect");
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async getZCodeTaskService(target) {
      const lease = await admit(target);
      await lease.connection.agentService.syncAppRuntimePreferences(
        await port.readRuntimePreferences(),
      );
      await assertLease(target, lease);
      return new Proxy(lease.connection.taskService, {
        get(base, property, receiver) {
          if (property === "onDynamicTaskEvent")
            return (params: Parameters<IZCodeTaskService["onDynamicTaskEvent"]>[0]) =>
              (receive: Parameters<ReturnType<IZCodeTaskService["onDynamicTaskEvent"]>>[0]) =>
                subscribe(target, lease, params, receive);
          const value: unknown = Reflect.get(base, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            await assertLease(target, lease);
            return Reflect.apply(value, base, args);
          };
        },
      });
    },
    async getModelSelectionService(target) {
      const lease = await admit(target);
      return {
        getView: async (...args) => {
          await assertLease(target, lease);
          return lease.connection.modelSelectionService.getView(...args);
        },
      };
    },
    async syncAppRuntimePreferences(preferences) {
      const hosts = new Set<string>();
      for (const target of await port.readBoundTargets()) {
        const host = await readHost(target);
        if (!host || hosts.has(host.id) || !port.resolveOnline(host.id)) continue;
        hosts.add(host.id);
        const lease = await admit(target);
        await lease.connection.agentService.syncAppRuntimePreferences(preferences);
      }
    },
  };
  return service;
}
