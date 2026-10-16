import { Emitter } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import { createTaskActivityTracker } from "../src/server-core/taskActivityTracker.js";

function fact(
  kind: "turn.started" | "turn.terminal",
  sessionId: string,
): ConversationTelemetryFact {
  const base = {
    version: 1 as const,
    eventId: `${kind}-${sessionId}`,
    eventSeq: 1,
    occurredAt: Date.now(),
    sessionId,
  };
  return kind === "turn.started"
    ? { ...base, kind }
    : { ...base, kind, status: "success" as const };
}

describe("Core-local TaskActivityTracker", () => {
  it("counts authoritative turn facts for all workspace clients and deduplicates by workspaceKey + sessionId", () => {
    const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
    const telemetryByWorkspace = new Map<string, Emitter<ConversationTelemetryFact>>();
    const workspaceKey = (target: ZCodeAgentWorkspaceTarget): string =>
      target.workspaceIdentity?.trim() || target.workspacePath;
    const agentService = {
      onAgentRuntimeLifecycle: lifecycle.event,
      onDynamicConversationTelemetryFact(target: ZCodeAgentWorkspaceTarget) {
        const key = workspaceKey(target);
        let emitter = telemetryByWorkspace.get(key);
        if (!emitter) {
          emitter = new Emitter<ConversationTelemetryFact>();
          telemetryByWorkspace.set(key, emitter);
        }
        return emitter.event;
      },
    } as Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact">;
    const tracker = createTaskActivityTracker(agentService);
    const targetA = { workspacePath: "/same/path", workspaceIdentity: "ssh://host-a/repo" };
    const targetB = { workspacePath: "/same/path", workspaceIdentity: "ssh://host-b/repo" };
    lifecycle.fire({
      ...targetA,
      workspaceKey: targetA.workspaceIdentity,
      runtimeIdentity: { generation: 1, identity: "runtime-a", workspaceKey: targetA.workspaceIdentity },
      state: "available",
    });
    lifecycle.fire({
      ...targetB,
      workspaceKey: targetB.workspaceIdentity,
      runtimeIdentity: { generation: 1, identity: "runtime-b", workspaceKey: targetB.workspaceIdentity },
      state: "available",
    });

    telemetryByWorkspace.get(targetA.workspaceIdentity)?.fire(fact("turn.started", "session-1"));
    telemetryByWorkspace.get(targetA.workspaceIdentity)?.fire(fact("turn.started", "session-1"));
    telemetryByWorkspace.get(targetB.workspaceIdentity)?.fire(fact("turn.started", "session-1"));
    expect(tracker.readRunningTaskCount()).toBe(2);

    telemetryByWorkspace.get(targetA.workspaceIdentity)?.fire(fact("turn.terminal", "session-1"));
    expect(tracker.readRunningTaskCount()).toBe(1);

    lifecycle.fire({
      ...targetB,
      workspaceKey: targetB.workspaceIdentity,
      runtimeIdentity: { generation: 1, identity: "runtime-b", workspaceKey: targetB.workspaceIdentity },
      state: "unavailable",
    });
    expect(tracker.readRunningTaskCount()).toBe(0);
    tracker.dispose();
  });

  it("publishes count changes immediately for Supervisor task-activity snapshots", () => {
    const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
    const telemetry = new Emitter<ConversationTelemetryFact>();
    const agentService = {
      onAgentRuntimeLifecycle: lifecycle.event,
      onDynamicConversationTelemetryFact: () => telemetry.event,
    } as Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact">;
    const tracker = createTaskActivityTracker(agentService);
    const counts: number[] = [];
    const subscription = tracker.onDidChangeRunningTaskCount((count) => counts.push(count));
    lifecycle.fire({
      workspacePath: "/repo",
      workspaceKey: "/repo",
      runtimeIdentity: { generation: 1, identity: "runtime", workspaceKey: "/repo" },
      state: "available",
    });
    telemetry.fire(fact("turn.started", "session"));
    telemetry.fire(fact("turn.terminal", "session"));
    expect(counts).toEqual([1, 0]);
    subscription.dispose();
    tracker.dispose();
  });
});
