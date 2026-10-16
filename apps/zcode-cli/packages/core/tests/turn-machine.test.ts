// ============================================================
// Test imports
// ============================================================
import { describe, it, expect } from "vitest";
import { createToolCallId } from "@zcode/contracts";
import { TurnMachineImpl } from "../src/agent/turn-machine.js";
import { TurnPhase } from "../src/agent/turn-state.js";

// -----------------------------------------------
// Turn Machine Tests
// -----------------------------------------------

describe("TurnMachine", () => {
  describe("state transitions", () => {
    it("should create a turn machine in Idle phase", () => {
      const machine = TurnMachineImpl.create("sess_123" as any, 1, "Hello");
      expect(machine.state.phase).toBe(TurnPhase.Idle);
      expect(machine.state.input).toBe("Hello");
    });

    it("should transition from Idle to ProcessingInput on start()", () => {
      const machine = TurnMachineImpl.create("sess_123" as any, 1, "Hello");
      const nextState = machine.start();
      expect(nextState.phase).toBe(TurnPhase.ProcessingInput);
    });

    it("should transition to AwaitingModelResponse", () => {
      const machine = startedMachine();
      const nextState = machine.startModelRequest("claude", []);
      expect(nextState.phase).toBe(TurnPhase.AwaitingModelResponse);
    });

    it("should drive a model-tool-model loop", () => {
      const toolCallId = createToolCallId("loop");
      const machine = modelWaitingMachine();
      const streaming = new TurnMachineImpl(machine.receiveModelResponse(""));
      const scheduled = new TurnMachineImpl(
        streaming.scheduleTools(
          [{ id: toolCallId, name: "Read", input: {} }],
          {
            items: [{ toolCallId, dependencies: [], canRunParallel: true }],
            parallelGroups: [[toolCallId]],
            executionOrder: [toolCallId],
          },
        ),
      );
      const executing = new TurnMachineImpl(scheduled.startToolExecution());
      const completed = new TurnMachineImpl(
        executing.completeTool(toolCallId, { success: true, content: "ok" }),
      );
      const aggregating = new TurnMachineImpl(completed.aggregateResults());

      const nextModel = aggregating.startModelRequest("claude", []);

      expect(nextModel.phase).toBe(TurnPhase.AwaitingModelResponse);
    });

    it("preserves structured tool result content", () => {
      const toolCallId = createToolCallId("image-result");
      const imageContent = [
        {
          type: "image" as const,
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
          source: { id: "read-image", kind: "inline" as const, placeholder: "Read image" },
        },
      ];
      const machine = modelWaitingMachine();
      const streaming = new TurnMachineImpl(machine.receiveModelResponse(""));
      const scheduled = new TurnMachineImpl(
        streaming.scheduleTools(
          [{ id: toolCallId, name: "ReadImage", input: {} }],
          {
            items: [{ toolCallId, dependencies: [], canRunParallel: true }],
            parallelGroups: [[toolCallId]],
            executionOrder: [toolCallId],
          },
        ),
      );
      const executing = new TurnMachineImpl(scheduled.startToolExecution());

      const completed = executing.completeTool(toolCallId, {
        success: true,
        content: imageContent,
      });

      expect(completed.toolResults.at(-1)?.content).toEqual(imageContent);
      expect(completed.toolCalls.at(-1)?.result?.content).toEqual(imageContent);
    });

    it("should complete a turn", () => {
      const machine = modelWaitingMachine();

      const nextState = machine.complete("Goodbye");
      expect(nextState.phase).toBe(TurnPhase.Completing);
      expect(nextState.finalResponse).toBe("Goodbye");
    });

    it("should throw on invalid transition", () => {
      const machine = TurnMachineImpl.create("sess_123" as any, 1, "Hello");
      expect(() => machine.complete("test")).toThrow();
    });
  });
});

function startedMachine(): TurnMachineImpl {
  const machine = TurnMachineImpl.create("sess_123" as any, 1, "Hello");
  return new TurnMachineImpl(machine.start());
}

function modelWaitingMachine(): TurnMachineImpl {
  const machine = startedMachine();
  return new TurnMachineImpl(machine.startModelRequest("claude", []));
}
