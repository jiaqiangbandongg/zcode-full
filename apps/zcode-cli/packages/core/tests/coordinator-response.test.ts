import { createSessionId, createTraceId, createTurnId, type TraceContext } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCoordinatorResponsePort } from "../src/subagent/coordinator-response.js";

const traceContext: TraceContext = {
  traceId: createTraceId("trace_coordinator_response"),
  turnId: createTurnId("turn_coordinator_response"),
};

describe("createCoordinatorResponsePort", () => {
  it("binds routing identity in the port closure before enqueueing", () => {
    const enqueue = vi.fn();
    const port = createCoordinatorResponsePort({
      agentId: "agent_bound",
      agentType: "Explore",
      childSessionId: createSessionId("child_bound"),
      parentToolCallId: "parent_tool_bound",
      createResponseId: () => "response_bound",
      enqueue,
    });

    expect(
      port.respond({
        childToolCallId: "child_tool_runtime",
        summary: "当前进度",
        message: "已检查权限链路，继续处理剩余任务。",
        trace: traceContext,
      }),
    ).toEqual({
      status: "success",
      responseId: "response_bound",
      message: "Response was queued for the coordinator.",
    });
    expect(enqueue).toHaveBeenCalledWith({
      responseId: "response_bound",
      agentId: "agent_bound",
      agentType: "Explore",
      childSessionId: createSessionId("child_bound"),
      childToolCallId: "child_tool_runtime",
      parentToolCallId: "parent_tool_bound",
      summary: "当前进度",
      message: "已检查权限链路，继续处理剩余任务。",
      traceContext,
    });
  });

  it("returns a complete failure result when the parent enqueue rejects synchronously", () => {
    const port = createCoordinatorResponsePort({
      agentId: "agent_failed",
      agentType: "general-purpose",
      childSessionId: createSessionId("child_failed"),
      createResponseId: () => "response_failed",
      enqueue() {
        throw new Error("parent queue sealed");
      },
    });

    expect(
      port.respond({
        childToolCallId: "child_tool_failed",
        summary: "进度回复",
        message: "继续执行。",
        trace: traceContext,
      }),
    ).toEqual({
      status: "failed",
      responseId: "response_failed",
      message: "Response could not be queued for the coordinator.",
      error: "parent queue sealed",
    });
  });
});
