import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  SessionEventType,
  type SessionEvent,
  type WorkflowPort,
  type WorkflowStartRequest,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { workflowToolEntry } from "../src/tool/handlers/workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";

describe("Workflow tool", () => {
  it("keeps Workflow out of built-in registration even when orchestration is configured", () => {
    const defaultRegistry = createToolRegistry();
    registerBuiltInTools(defaultRegistry, { includeAgent: true });
    expect(defaultRegistry.has("Workflow")).toBe(false);

    const workflowRegistry = createToolRegistry();
    registerBuiltInTools(workflowRegistry, { includeWorkflow: true });
    expect(workflowRegistry.has("Workflow")).toBe(false);
    expect(workflowRegistry.toContracts().map((contract) => contract.name)).not.toContain(
      "Workflow",
    );
    expect(workflowToolEntry.metadata.description).toContain("ONLY call this tool");
  });

  it("delegates launch requests to WorkflowPort with session and trace context", async () => {
    const sessionId = createSessionId("workflow-tool");
    const turnId = createTurnId("workflow-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("workflow");
    const events: SessionEvent[] = [];
    let captured: WorkflowStartRequest | undefined;
    const workflowPort: WorkflowPort = {
      async start(request) {
        captured = request;
        return {
          backgroundTaskId: "wf_abc123",
          response: "started",
          runId: "wf_abc123",
          scriptPath: request.scriptPath,
          status: "backgrounded",
          traceId: request.trace.traceId,
        };
      },
    };
    const registry = createToolRegistry();
    registry.register(workflowToolEntry);
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "yolo",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workflowPort,
      workingDirectory: "/repo",
      workspaceRoot: "/repo",
    });

    const result = await executor.execute({
      id: toolCallId,
      input: { scriptPath: "review.workflow.js" },
      name: "Workflow",
    });

    expect(result.success).toBe(true);
    expect(captured).toMatchObject({
      parentToolCallId: toolCallId,
      scriptPath: "review.workflow.js",
      sessionId,
      turnId,
      workingDirectory: "/repo",
      workspaceRoot: "/repo",
    });
    expect(captured?.trace.traceId).toBe(traceContext.traceId);
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set([traceContext.traceId]));
    expect(events.map((event) => event.type)).toContain(SessionEventType.BackgroundTaskStarted);
  });

  it("fails closed when WorkflowPort is unavailable", async () => {
    const sessionId = createSessionId("workflow-tool-missing");
    const registry = createToolRegistry();
    registry.register(workflowToolEntry);
    const executor = createToolExecutor({
      emitEvent: async () => {},
      mode: "yolo",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
    });

    const result = await executor.execute({
      id: createToolCallId("workflow-missing"),
      input: { scriptPath: "review.workflow.js" },
      name: "Workflow",
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("WorkflowPort is not configured");
  });
});
