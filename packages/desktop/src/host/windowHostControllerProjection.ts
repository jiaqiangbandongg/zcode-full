/* eslint-disable max-lines -- 投影状态、V4 帧与离线替换属于同一个一致性边界。 */
import { isDeepStrictEqual } from "node:util";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeArchivedTaskDeletionResult } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type ControllerSubscribeResult,
  type WindowHostControllerTaskDelta,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
  type WindowHostControllerTopic,
  type WindowHostControllerWorkspaceDelta,
  type WindowHostControllerWorkspaceFact,
  type WindowHostControllerWorkspaceFrame,
  type WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";

export type WindowHostControllerSourceScope =
  | {
      kind: "local";
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "remote";
      remoteSessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    };

export interface WindowHostControllerTaskMembership {
  meta: ZCodeTaskMeta;
  membership: {
    pinned: boolean;
    archived: boolean;
    active: boolean;
  };
  searchSnippets?: string[];
}

export interface WindowHostControllerSessionOverlay {
  taskId: string;
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  title?: string;
  titleSource?: "default" | "generated" | "custom";
  updatedAt?: number;
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
  activity?: NonNullable<WindowHostControllerTaskRow["activity"]>;
}

export type WindowHostControllerMutation =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "delete-archived-batch"; taskIds: string[] }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerMutationResult = void | boolean | ZCodeArchivedTaskDeletionResult;

interface ControllerSource {
  scope: WindowHostControllerSourceScope;
  sourceAvailability: "online" | "offline";
  connectionState: WindowHostControllerWorkspaceFact["connectionState"];
  memberships: Map<string, WindowHostControllerTaskMembership>;
  overlays: Map<string, WindowHostControllerSessionOverlay>;
  rows: Map<string, WindowHostControllerTaskRow>;
  mutate: (
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ) => Promise<WindowHostControllerMutationResult> | WindowHostControllerMutationResult;
}

interface ControllerSubscriber {
  topic: WindowHostControllerTopic;
  subscriptionId: string;
  onFrame: (frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame) => void;
}

interface TopicState {
  logEpoch: string;
  seq: number;
}

function sourceKey(scope: WindowHostControllerSourceScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return scope.kind === "remote"
    ? `remote\0${scope.remoteSessionId}\0${workspaceKey}`
    : `local\0${workspaceKey}`;
}

function addressFor(scope: WindowHostControllerSourceScope, taskId: string): WindowHostTaskAddress {
  return {
    ...(scope.kind === "remote" ? { remoteSessionId: scope.remoteSessionId } : {}),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    taskId,
  };
}

function taskKey(address: WindowHostTaskAddress): string {
  return `${address.remoteSessionId ?? "local"}\0${address.workspaceIdentity?.trim() || address.workspacePath}\0${address.taskId}`;
}

function defaultLiveStatus(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  // live overlay 缺失表示当前没有可证明的 runtime；SQLite 里的 running/interaction
  // 可能来自上次进程退出，不能重新解释成当前运行或等待事实。
  switch (meta.status) {
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function statusFromActivity(
  activity: NonNullable<WindowHostControllerSessionOverlay["activity"]>,
): ZCodeTaskMeta["status"] {
  switch (activity.phase) {
    case "prewarming":
    case "running":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    case "draft":
      return undefined;
  }
}

function buildSourceRows(source: ControllerSource): Map<string, WindowHostControllerTaskRow> {
  const rows = new Map<string, WindowHostControllerTaskRow>();
  for (const membership of source.memberships.values()) {
    const overlay = source.overlays.get(membership.meta.taskId);
    const shouldUseOverlayTitle =
      overlay?.title != null &&
      (membership.meta.titleOverridden !== true || overlay.titleSource === "custom");
    const meta = overlay
      ? {
          ...membership.meta,
          ...(shouldUseOverlayTitle ? { title: overlay.title } : {}),
          ...(overlay.titleSource === "custom" ? { titleOverridden: true } : {}),
          ...(overlay.updatedAt != null ? { updatedAt: overlay.updatedAt } : {}),
          ...(overlay.activity ? { status: statusFromActivity(overlay.activity) } : {}),
          pendingInteraction: overlay.pendingInteraction,
        }
      : membership.meta;
    const address = addressFor(source.scope, meta.taskId);
    rows.set(taskKey(address), {
      address,
      meta,
      membership: membership.membership,
      sourceAvailability: source.sourceAvailability,
      liveStatus: overlay?.liveStatus ?? defaultLiveStatus(meta),
      ...(overlay?.activity ? { activity: overlay.activity } : {}),
      ...(membership.searchSnippets ? { searchSnippets: membership.searchSnippets } : {}),
    });
  }
  return rows;
}

function validateMembershipScope(
  scope: WindowHostControllerSourceScope,
  membership: WindowHostControllerTaskMembership,
): void {
  if (
    membership.meta.workspacePath !== scope.workspacePath ||
    membership.meta.workspaceIdentity !== scope.workspaceIdentity
  ) {
    throw new Error(
      `task-index membership 与 source scope 不匹配，taskId=${membership.meta.taskId}`,
    );
  }
}

function workspaceFact(source: ControllerSource): WindowHostControllerWorkspaceFact {
  return {
    ...(source.scope.kind === "remote" ? { remoteSessionId: source.scope.remoteSessionId } : {}),
    workspacePath: source.scope.workspacePath,
    ...(source.scope.workspaceIdentity
      ? { workspaceIdentity: source.scope.workspaceIdentity }
      : {}),
    sourceAvailability: source.sourceAvailability,
    connectionState: source.connectionState,
  };
}

export function createWindowHostControllerProjection(options: { createId: () => string }) {
  const sources = new Map<string, ControllerSource>();
  const subscribers = new Map<string, ControllerSubscriber>();
  const topicStates: Record<WindowHostControllerTopic, TopicState> = {
    [CONTROLLER_TASKS_INDEX_TOPIC]: { logEpoch: options.createId(), seq: 0 },
    [CONTROLLER_WORKSPACES_TOPIC]: { logEpoch: options.createId(), seq: 0 },
  };

  function allRows(): WindowHostControllerTaskRow[] {
    return Array.from(sources.values())
      .flatMap((source) => Array.from(source.rows.values()))
      .sort(
        (left, right) =>
          right.meta.updatedAt - left.meta.updatedAt ||
          taskKey(left.address).localeCompare(taskKey(right.address)),
      );
  }

  function allWorkspaceFacts(): WindowHostControllerWorkspaceFact[] {
    return Array.from(sources.values(), workspaceFact).sort((left, right) => {
      const leftKey = `${left.remoteSessionId ?? "local"}\0${left.workspaceIdentity ?? left.workspacePath}`;
      const rightKey = `${right.remoteSessionId ?? "local"}\0${right.workspaceIdentity ?? right.workspacePath}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  function snapshotFrame(
    subscriber: ControllerSubscriber,
  ): WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame {
    const state = topicStates[subscriber.topic];
    const common = {
      subscriptionId: subscriber.subscriptionId,
      logEpoch: state.logEpoch,
      fromSeq: 0,
      toSeq: state.seq,
      sentAt: Date.now(),
    };
    if (subscriber.topic === CONTROLLER_TASKS_INDEX_TOPIC) {
      return {
        ...common,
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        payload: {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            logEpoch: state.logEpoch,
            tasks: allRows(),
          },
        },
      };
    }
    return {
      ...common,
      topic: CONTROLLER_WORKSPACES_TOPIC,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          logEpoch: state.logEpoch,
          workspaces: allWorkspaceFacts(),
        },
      },
    };
  }

  function publishTaskDeltas(deltas: WindowHostControllerTaskDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    const state = topicStates[CONTROLLER_TASKS_INDEX_TOPIC];
    const fromSeq = state.seq;
    state.seq += 1;
    for (const subscriber of subscribers.values()) {
      if (subscriber.topic !== CONTROLLER_TASKS_INDEX_TOPIC) {
        continue;
      }
      subscriber.onFrame({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: subscriber.subscriptionId,
        logEpoch: state.logEpoch,
        fromSeq,
        toSeq: state.seq,
        sentAt: Date.now(),
        payload: { kind: "deltas", deltas },
      });
    }
  }

  function publishWorkspaceDeltas(deltas: WindowHostControllerWorkspaceDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    const state = topicStates[CONTROLLER_WORKSPACES_TOPIC];
    const fromSeq = state.seq;
    state.seq += 1;
    for (const subscriber of subscribers.values()) {
      if (subscriber.topic !== CONTROLLER_WORKSPACES_TOPIC) {
        continue;
      }
      subscriber.onFrame({
        topic: CONTROLLER_WORKSPACES_TOPIC,
        subscriptionId: subscriber.subscriptionId,
        logEpoch: state.logEpoch,
        fromSeq,
        toSeq: state.seq,
        sentAt: Date.now(),
        payload: { kind: "deltas", deltas },
      });
    }
  }

  function requireSource(scope: WindowHostControllerSourceScope): ControllerSource {
    const source = sources.get(sourceKey(scope));
    if (!source) {
      throw new Error(
        `没有与 scope 匹配的 Controller source，workspacePath=${scope.workspacePath}`,
      );
    }
    return source;
  }

  return {
    registerSource(params: {
      scope: WindowHostControllerSourceScope;
      mutate: ControllerSource["mutate"];
    }): void {
      if (params.scope.kind === "remote" && !params.scope.workspaceIdentity.trim()) {
        throw new Error("远程 Controller source 必须携带 workspaceIdentity");
      }
      const key = sourceKey(params.scope);
      const existing = sources.get(key);
      if (existing) {
        existing.mutate = params.mutate;
        return;
      }
      sources.set(key, {
        scope: params.scope,
        sourceAvailability: "offline",
        connectionState: "connecting",
        memberships: new Map(),
        overlays: new Map(),
        rows: new Map(),
        mutate: params.mutate,
      });
    },

    replaceSourceSnapshot(params: {
      scope: WindowHostControllerSourceScope;
      taskIndex: WindowHostControllerTaskMembership[];
      sessionsIndex: WindowHostControllerSessionOverlay[];
      replacesScope?: WindowHostControllerSourceScope;
    }): void {
      const source = requireSource(params.scope);
      const previousWorkspaceFact = workspaceFact(source);
      const currentSourceKey = sourceKey(params.scope);
      const replacementCandidate = params.replacesScope
        ? sources.get(sourceKey(params.replacesScope))
        : undefined;
      const replacedSource =
        replacementCandidate && sourceKey(replacementCandidate.scope) !== currentSourceKey
          ? replacementCandidate
          : undefined;
      if (replacedSource) {
        // 重连的 remoteSessionId 会变化；先在内存里摘掉旧 source，再用一个 task delta frame
        // 同时发布 old removals + new upserts，消费者不会看到中间空投影。
        sources.delete(sourceKey(replacedSource.scope));
      }
      const previousRows = source.rows;
      const nextMemberships = new Map<string, WindowHostControllerTaskMembership>();
      for (const membership of params.taskIndex) {
        validateMembershipScope(params.scope, membership);
        const address = addressFor(params.scope, membership.meta.taskId);
        nextMemberships.set(taskKey(address), membership);
      }
      source.memberships = nextMemberships;
      source.overlays = new Map(params.sessionsIndex.map((overlay) => [overlay.taskId, overlay]));
      source.sourceAvailability = "online";
      const nextRows = buildSourceRows(source);
      source.rows = nextRows;
      source.connectionState = "online";

      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const previous of replacedSource?.rows.values() ?? []) {
        deltas.push({ op: "task.removed", address: previous.address });
      }
      for (const [key, previous] of previousRows) {
        if (!nextRows.has(key)) {
          deltas.push({ op: "task.removed", address: previous.address });
        }
      }
      for (const task of nextRows.values()) {
        const previous = previousRows.get(taskKey(task.address));
        if (!previous || !isDeepStrictEqual(previous, task)) {
          deltas.push({ op: "task.upserted", task });
        }
      }
      publishTaskDeltas(deltas);
      const nextWorkspaceFact = workspaceFact(source);
      const workspaceDeltas: WindowHostControllerWorkspaceDelta[] = [
        ...(replacedSource
          ? [
              {
                op: "workspace.removed" as const,
                ...(replacedSource.scope.kind === "remote"
                  ? { remoteSessionId: replacedSource.scope.remoteSessionId }
                  : {}),
                workspacePath: replacedSource.scope.workspacePath,
                ...(replacedSource.scope.workspaceIdentity
                  ? { workspaceIdentity: replacedSource.scope.workspaceIdentity }
                  : {}),
              },
            ]
          : []),
        ...(!isDeepStrictEqual(previousWorkspaceFact, nextWorkspaceFact) || replacedSource
          ? [{ op: "workspace.upserted" as const, workspace: nextWorkspaceFact }]
          : []),
      ];
      publishWorkspaceDeltas(workspaceDeltas);
    },

    replaceSourceSessionOverlays(
      scope: WindowHostControllerSourceScope,
      sessionsIndex: WindowHostControllerSessionOverlay[],
    ): void {
      const source = requireSource(scope);
      const previousRows = source.rows;
      source.overlays = new Map(sessionsIndex.map((overlay) => [overlay.taskId, overlay]));
      source.rows = buildSourceRows(source);
      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const task of source.rows.values()) {
        const previous = previousRows.get(taskKey(task.address));
        if (!previous || !isDeepStrictEqual(previous, task)) {
          deltas.push({ op: "task.upserted", task });
        }
      }
      publishTaskDeltas(deltas);
    },

    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const source = requireSource(scope);
      source.sourceAvailability = "offline";
      source.connectionState = "disconnected";
      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const [key, row] of source.rows) {
        const offlineRow = { ...row, sourceAvailability: "offline" as const };
        source.rows.set(key, offlineRow);
        deltas.push({ op: "task.upserted", task: offlineRow });
      }
      publishTaskDeltas(deltas);
      publishWorkspaceDeltas([{ op: "workspace.upserted", workspace: workspaceFact(source) }]);
    },

    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      const source = sources.get(key);
      if (!source) {
        return;
      }
      sources.delete(key);
      publishTaskDeltas(
        Array.from(source.rows.values(), (task) => ({
          op: "task.removed" as const,
          address: task.address,
        })),
      );
      publishWorkspaceDeltas([
        {
          op: "workspace.removed",
          ...(scope.kind === "remote" ? { remoteSessionId: scope.remoteSessionId } : {}),
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
      ]);
    },

    getTasks: allRows,
    getGroupedTaskFacts(): WindowHostControllerTaskRow[] {
      return allRows().filter((task) => !task.address.remoteSessionId);
    },

    async mutate(
      address: WindowHostTaskAddress,
      mutation: WindowHostControllerMutation,
    ): Promise<WindowHostControllerMutationResult> {
      const source = Array.from(sources.values()).find((candidate) => {
        if (candidate.scope.workspacePath !== address.workspacePath) {
          return false;
        }
        if (candidate.scope.workspaceIdentity !== address.workspaceIdentity) {
          return false;
        }
        if (candidate.scope.kind === "remote") {
          return candidate.scope.remoteSessionId === address.remoteSessionId;
        }
        return address.remoteSessionId == null;
      });
      if (
        !source ||
        (mutation.kind !== "delete-archived" &&
          mutation.kind !== "delete-archived-batch" &&
          !source.rows.has(taskKey(address)))
      ) {
        throw new Error("没有与任务地址匹配的 source");
      }
      if (source.sourceAvailability !== "online") {
        if (source.scope.kind === "remote") {
          throw new Error("远程 source 当前离线，禁止列表写操作");
        }
        throw new Error("本地 source 当前不可用");
      }
      return source.mutate(address, mutation);
    },

    subscribe(params: {
      topic: WindowHostControllerTopic;
      onFrame: ControllerSubscriber["onFrame"];
    }): ControllerSubscribeResult["ack"] & {
      ack: ControllerSubscribeResult["ack"];
      dispose(): void;
    } {
      const subscriptionId = options.createId();
      const subscriber: ControllerSubscriber = {
        topic: params.topic,
        subscriptionId,
        onFrame: params.onFrame,
      };
      subscribers.set(subscriptionId, subscriber);
      const state = topicStates[params.topic];
      const ack: ControllerSubscribeResult["ack"] = {
        subscriptionId,
        mode: "snapshot",
        logEpoch: state.logEpoch,
      };
      params.onFrame(snapshotFrame(subscriber));
      return {
        ...ack,
        ack,
        dispose() {
          subscribers.delete(subscriptionId);
        },
      };
    },

    resync(subscriptionId: string): ControllerSubscribeResult["ack"] {
      const subscriber = subscribers.get(subscriptionId);
      if (!subscriber) {
        throw new Error(`未找到 Controller subscription，subscriptionId=${subscriptionId}`);
      }
      paramsOnFrameSafe(subscriber, snapshotFrame(subscriber));
      const state = topicStates[subscriber.topic];
      return { subscriptionId, mode: "snapshot", logEpoch: state.logEpoch };
    },
  };
}

function paramsOnFrameSafe(
  subscriber: ControllerSubscriber,
  frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame,
): void {
  subscriber.onFrame(frame);
}
