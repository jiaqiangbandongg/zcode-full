import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

export interface TaskActivityTracker extends IDisposable {
  readonly onDidChangeRunningTaskCount: Event<number>;
  readRunningTaskCount(): number;
}

type AgentActivitySource = Pick<
  IZCodeAgentService,
  "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact"
>;

interface WorkspaceActivity {
  activeSessionIds: Set<string>;
  runtimeIdentity: string;
  telemetry: IDisposable;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function createTaskActivityTracker(
  source: AgentActivitySource | undefined,
): TaskActivityTracker {
  const changed = new Emitter<number>();
  const workspaces = new Map<string, WorkspaceActivity>();
  let runningTaskCount = 0;
  let disposed = false;

  const publishCount = (): void => {
    const next = [...workspaces.values()].reduce(
      (total, workspace) => total + workspace.activeSessionIds.size,
      0,
    );
    if (next === runningTaskCount) return;
    runningTaskCount = next;
    changed.fire(next);
  };

  const removeWorkspace = (key: string, runtimeIdentity?: string): void => {
    const current = workspaces.get(key);
    if (!current || (runtimeIdentity && current.runtimeIdentity !== runtimeIdentity)) return;
    current.telemetry.dispose();
    workspaces.delete(key);
    publishCount();
  };

  const acceptFact = (key: string, fact: ConversationTelemetryFact): void => {
    const workspace = workspaces.get(key);
    if (!workspace) return;
    if (fact.kind === "turn.started") {
      workspace.activeSessionIds.add(fact.sessionId);
    } else if (fact.kind === "turn.terminal") {
      workspace.activeSessionIds.delete(fact.sessionId);
    } else {
      return;
    }
    publishCount();
  };

  const acceptLifecycle = (event: ZCodeAgentRuntimeLifecycleEvent): void => {
    if (disposed) return;
    const key = event.workspaceKey || workspaceKey(event);
    if (event.state === "unavailable") {
      removeWorkspace(key, event.runtimeIdentity.identity);
      return;
    }
    removeWorkspace(key);
    const activeSessionIds = new Set<string>();
    const telemetry = source?.onDynamicConversationTelemetryFact(event)((fact) => acceptFact(key, fact));
    if (!telemetry) return;
    workspaces.set(key, {
      activeSessionIds,
      runtimeIdentity: event.runtimeIdentity.identity,
      telemetry,
    });
  };

  const lifecycle = source?.onAgentRuntimeLifecycle?.(acceptLifecycle);
  return {
    onDidChangeRunningTaskCount: changed.event,
    readRunningTaskCount: () => runningTaskCount,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifecycle?.dispose();
      for (const workspace of workspaces.values()) workspace.telemetry.dispose();
      workspaces.clear();
      runningTaskCount = 0;
      changed.dispose();
    },
  };
}
