import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createFileSystemError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type FileSystemPort,
  type PermissionBrokerPort,
  type SessionEvent,
  type SessionModePort,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import {
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "../src/tool/handlers/plan-mode.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

describe("plan mode tools", () => {
  it("enters plan mode without requesting approval", async () => {
    const sessionId = createSessionId("enter-plan-mode");
    const turnId = createTurnId("enter-plan-mode");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("enter-plan");
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "build";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined;
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    let requestCount = 0;
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        requestCount++;
        return { decision: "allow", reason: "approved" };
      },
    };

    const result = await createPlanModeExecutor({
      events,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
    }).execute(
      {
        id: toolCallId,
        input: {},
        name: "EnterPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      mode: "plan",
      previousMode: "build",
    });
    expect(result.modelContent).toContain("Entered plan mode.");
    expect(result.modelContent).toContain("DO NOT write or edit any files yet");
    expect(mode).toBe("plan");
    expect(prePlanMode).toBe("build");
    expect(requestCount).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("requests approval before exiting plan mode and returns the approved plan", async () => {
    const sessionId = createSessionId("exit-plan-mode");
    const turnId = createTurnId("exit-plan-mode");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("exit-plan");
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "plan";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined = "build";
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        expect(request.toolName).toBe("ExitPlanMode");
        const approvedPlan = "\n  1. Update the service boundary\n2. Add tests\n\n";
        return {
          decision: "modify",
          modifiedInput: {
            ...(request.input as Record<string, unknown>),
            plan: approvedPlan,
          },
          reason: "approved with edits",
        };
      },
    };
    const fileSystemPort = new MemoryFileSystem({});

    const result = await createPlanModeExecutor({
      events,
      fileSystemPort,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
    }).execute(
      {
        id: toolCallId,
        input: {
          plan: "1. Update the service boundary",
        },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      approved: true,
      mode: "build",
      plan: "\n  1. Update the service boundary\n2. Add tests\n\n",
      previousMode: "plan",
    });
    expect(result.modelContent).toContain("User has approved your plan");
    expect(result.modelContent).toContain("## Approved Plan");
    expect(
      fileSystemPort.files["/workspace/project/.zcode/plans/plan-sess_exit-plan-mode.md"],
    ).toBe("\n  1. Update the service boundary\n2. Add tests\n\n");
    expect(mode).toBe("build");
    expect(prePlanMode).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("asks for approval before exiting plan mode entered from yolo", async () => {
    const sessionId = createSessionId("yolo-plan-mode");
    const turnId = createTurnId("yolo-plan-mode");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "yolo";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined;
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    let requestCount = 0;
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        requestCount++;
        return { decision: "allow" };
      },
    };
    const executor = createPlanModeExecutor({
      events,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
    });

    const enterResult = await executor.execute(
      {
        id: createToolCallId("enter-plan-yolo"),
        input: {},
        name: "EnterPlanMode",
      },
      { traceContext },
    );
    const exitResult = await executor.execute(
      {
        id: createToolCallId("exit-plan-yolo"),
        input: { plan: "1. Implement the change\n2. Run tests" },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(enterResult.success).toBe(true);
    expect(exitResult.success).toBe(true);
    expect(enterResult.output).toMatchObject({ mode: "plan", previousMode: "yolo" });
    expect(exitResult.output).toMatchObject({ mode: "yolo", previousMode: "plan" });
    expect(mode).toBe("yolo");
    expect(prePlanMode).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("exits plan mode back to edit mode after approval", async () => {
    const sessionId = createSessionId("edit-plan-mode");
    const turnId = createTurnId("edit-plan-mode");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "edit";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined;
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    let requestCount = 0;
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        requestCount++;
        return { decision: "allow" };
      },
    };
    const executor = createPlanModeExecutor({
      events,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
    });

    const enterResult = await executor.execute(
      {
        id: createToolCallId("enter-plan-edit"),
        input: {},
        name: "EnterPlanMode",
      },
      { traceContext },
    );
    const exitResult = await executor.execute(
      {
        id: createToolCallId("exit-plan-edit"),
        input: { plan: "1. Implement the change\n2. Run tests" },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(enterResult.output).toMatchObject({ mode: "plan", previousMode: "edit" });
    expect(exitResult.output).toMatchObject({ mode: "edit", previousMode: "plan" });
    expect(mode).toBe("edit");
    expect(prePlanMode).toBeUndefined();
    expect(requestCount).toBe(1);
  });

  it("does not ask for ExitPlanMode approval outside plan mode", async () => {
    const sessionId = createSessionId("exit-plan-mode-denied");
    const turnId = createTurnId("exit-plan-mode-denied");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    let requestCount = 0;
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        requestCount++;
        return { decision: "allow" };
      },
    };

    const result = await createPlanModeExecutor({
      events: [],
      mode: () => "build",
      permissionBroker,
      sessionId,
      sessionModePort: createSessionModePort({
        getMode: () => "build",
        getPrePlanMode: () => undefined,
        setMode: () => {},
        setPrePlanMode: () => {},
      }),
      traceContext,
      turnId,
    }).execute(
      {
        id: createToolCallId("exit-plan-denied"),
        input: { plan: "A plan that should not be approved outside plan mode." },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("ExitPlanMode can only be used");
    expect(requestCount).toBe(0);
  });

  it("exits plan mode when approved plan file write fails", async () => {
    const sessionId = createSessionId("exit-plan-write-fails");
    const turnId = createTurnId("exit-plan-write-fails");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "plan";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined = "build";
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        return { decision: "allow", reason: "approved" };
      },
    };
    const baseFileSystemPort = new MemoryFileSystem({});
    const fileSystemPort: FileSystemPort = {
      ...baseFileSystemPort,
      async writeTextFile() {
        throw new Error("disk is read-only for plan file");
      },
    };

    const result = await createPlanModeExecutor({
      events,
      fileSystemPort,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
      workspaceRoot: "/workspace/project",
    }).execute(
      {
        id: createToolCallId("exit-plan-write-fails"),
        input: {
          plan: "1. This plan should still exit if file persistence fails.",
        },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("User has approved your plan");
    expect(result.modelContent).toContain(
      "1. This plan should still exit if file persistence fails.",
    );
    expect(mode).toBe("build");
    expect(prePlanMode).toBeUndefined();
  });

  it("keeps plan mode active when approved plan file write is cancelled", async () => {
    const sessionId = createSessionId("exit-plan-write-cancelled");
    const turnId = createTurnId("exit-plan-write-cancelled");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "plan";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined = "build";
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        return { decision: "allow", reason: "approved" };
      },
    };
    const baseFileSystemPort = new MemoryFileSystem({});
    const fileSystemPort: FileSystemPort = {
      ...baseFileSystemPort,
      async writeTextFile(request) {
        throw createFileSystemError({
          code: "cancelled",
          message: "plan file write was cancelled",
          path: request.path,
        });
      },
    };

    const result = await createPlanModeExecutor({
      events,
      fileSystemPort,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
      workspaceRoot: "/workspace/project",
    }).execute(
      {
        id: createToolCallId("exit-plan-write-cancelled"),
        input: {
          plan: "1. Cancelled persistence should not exit plan mode.",
        },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("tool_cancelled");
    expect(mode).toBe("plan");
    expect(prePlanMode).toBe("build");
  });
});

function createPlanModeExecutor(input: {
  events: SessionEvent[];
  fileSystemPort?: FileSystemPort;
  mode: () => CollaborationMode;
  permissionBroker: PermissionBrokerPort;
  sessionId: ReturnType<typeof createSessionId>;
  sessionModePort: SessionModePort;
  traceContext: ReturnType<typeof createRootTraceContext>;
  turnId: ReturnType<typeof createTurnId>;
  workingDirectory?: string;
  workspaceRoot?: string;
}) {
  const registry = createToolRegistry();
  registry.register(enterPlanModeToolEntry);
  registry.register(exitPlanModeToolEntry);

  return createToolExecutor({
    emitEvent: async (event) => {
      input.events.push(event);
    },
    fileSystemPort: input.fileSystemPort ?? new MemoryFileSystem({}),
    getMode: input.mode,
    permissionBroker: input.permissionBroker,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId: input.sessionId,
    sessionModePort: input.sessionModePort,
    traceContext: input.traceContext,
    turnId: input.turnId,
    workingDirectory: input.workingDirectory ?? "/workspace/project",
    workspaceRoot: input.workspaceRoot ?? "/workspace/project",
  });
}

function createSessionModePort(state: {
  getMode: () => CollaborationMode;
  getPrePlanMode: () => Exclude<CollaborationMode, "plan"> | undefined;
  setMode: (mode: CollaborationMode) => void;
  setPrePlanMode: (mode: Exclude<CollaborationMode, "plan"> | undefined) => void;
}): SessionModePort {
  return {
    getMode: state.getMode,
    getPrePlanMode: state.getPrePlanMode,
    async enterPlanMode() {
      const previousMode = state.getMode();
      if (previousMode !== "plan") {
        state.setPrePlanMode(previousMode);
      }
      state.setMode("plan");
      return { mode: "plan", previousMode };
    },
    async exitPlanMode() {
      if (state.getMode() !== "plan") {
        throw new Error("not in plan mode");
      }
      const mode = state.getPrePlanMode() ?? "build";
      state.setPrePlanMode(undefined);
      state.setMode(mode);
      return { mode, previousMode: "plan" };
    },
  };
}
