import { describe, expect, it, vi } from "vitest";
import { createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import type {
  RuntimeCommand,
  RuntimeCommandId,
  RuntimeCommandPriority,
} from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
} from "../src/runtime/methods/runtime-command-queue.js";

function command(id: string, priority: RuntimeCommandPriority): RuntimeCommand {
  return {
    createdAt: new Date(`2026-06-29T00:00:0${id.at(-1) ?? "0"}.000Z`),
    id: id as RuntimeCommandId,
    mode: "task-notification",
    priority,
    source: "background_task",
    text: `<task-notification><task-id>${id}</task-id></task-notification>`,
    traceContext: {
      sessionId: "sess_runtime_command_queue",
      spanId: `span_${id}`,
      traceId: "trace_runtime_command_queue",
    },
  } as RuntimeCommand;
}

function promptCommand(
  id: string,
  priority: RuntimeCommandPriority,
  inputId?: string,
): RuntimeCommand {
  return {
    createdAt: new Date("2026-06-29T00:01:00.000Z"),
    id: id as RuntimeCommandId,
    input: id,
    mode: "prompt",
    ...(inputId ? { options: { inputId } } : {}),
    priority,
    reject: () => {},
    resolve: () => {},
    traceContext: {
      sessionId: "sess_runtime_command_queue",
      spanId: `span_${id}`,
      traceId: "trace_runtime_command_queue",
    },
  } as RuntimeCommand;
}

describe("RuntimeCommandQueue", () => {
  it("dequeues commands by priority before FIFO order", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));
    queue.enqueue(command("next-2", "next"));

    expect(queue.dequeue()?.id).toBe("now-1");
    expect(queue.dequeue()?.id).toBe("next-1");
    expect(queue.dequeue()?.id).toBe("next-2");
    expect(queue.dequeue()?.id).toBe("later-1");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("preserves FIFO order for commands with the same priority", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("next-2", "next"));
    queue.enqueue(command("next-3", "next"));

    expect(queue.dequeue()?.id).toBe("next-1");
    expect(queue.dequeue()?.id).toBe("next-2");
    expect(queue.dequeue()?.id).toBe("next-3");
  });

  it("dequeues all same-priority task notifications as one frozen batch", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("next-2", "next"));
    queue.enqueue(command("later-1", "later"));

    const batch = queue.dequeueNextBatch();

    expect(Object.isFrozen(batch)).toBe(true);
    expect(batch.map((item) => item.id)).toEqual(["next-1", "next-2"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["later-1"]);
    expect(queue.dequeueNextBatch()).toEqual([]);
  });

  it("collects task notifications across later same-priority modes", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("next-1", "next"));
    queue.enqueue(promptCommand("prompt-1", "next"));
    queue.enqueue(command("next-2", "next"));

    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["next-1", "next-2"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-1"]);
  });

  it("does not batch past a higher-priority or earlier same-priority command", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(promptCommand("prompt-next", "next"));
    queue.enqueue(command("notification-next-1", "next"));
    queue.enqueue(promptCommand("prompt-now", "now"));
    queue.enqueue(command("notification-next-2", "next"));
    queue.enqueue(command("notification-later", "later"));

    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-now"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-next"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual([
      "notification-next-1",
      "notification-next-2",
    ]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["notification-later"]);
  });

  it("returns a frozen snapshot that cannot mutate the queue", () => {
    const queue = createRuntimeCommandQueue();
    queue.enqueue(command("next-1", "next"));

    const snapshot = queue.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as RuntimeCommand[]).push(command("now-1", "now"));
    }).toThrow();
    expect(queue.size()).toBe(1);
  });

  it("removes queued commands by id without touching other priorities", () => {
    const queue = createRuntimeCommandQueue();
    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));

    const removed = queue.removeById("next-1" as RuntimeCommandId);

    expect(removed?.id).toBe("next-1");
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.id).toBe("now-1");
    expect(queue.dequeue()?.id).toBe("later-1");
  });

  it("returns all commands at or above the requested priority rank in enqueue order", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));
    queue.enqueue(command("next-2", "next"));
    queue.enqueue(command("later-2", "later"));

    const selected = queue.getByMaxPriority("next");

    expect(selected.map((item) => item.id)).toEqual(["next-1", "now-1", "next-2"]);
    expect(queue.size()).toBe(5);
    for (const item of selected) {
      queue.removeById(item.id);
    }
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.id).toBe("later-1");
    expect(queue.dequeue()?.id).toBe("later-2");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("tracks cancel-pending ids when removal races with dequeue", () => {
    const queue = createRuntimeCommandQueue();
    const id = "next-1" as RuntimeCommandId;

    expect(queue.consumeCancelPending(id)).toBe(false);
    queue.markCancelPending(id);

    expect(queue.consumeCancelPending(id)).toBe(true);
    expect(queue.consumeCancelPending(id)).toBe(false);
  });

  it("holds earlier runtime work until the leased promoted command is runnable", async () => {
    const executionOrder: string[] = [];
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      executeTurnCommand: vi.fn().mockImplementation(async (input: string) => {
        executionOrder.push(input);
        return {};
      }),
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;

    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "lease-bg44",
        mode: "after-current",
        promotedInputId: "lease-bg44",
      }),
    ).toEqual({ kind: "acquired", leaseId: "lease-bg44" });
    runtime.runtimeCommandQueue.enqueue(promptCommand("notification-b", "next"));

    await drainRuntimeCommandQueue.call(runtime);
    expect(executionOrder).toEqual([]);
    expect(runtime.runtimeCommandQueue.size()).toBe(1);

    runtime.runtimeCommandQueue.enqueue(promptCommand("promoted-prompt", "next", "lease-bg44"));
    await drainRuntimeCommandQueue.call(runtime);

    expect(executionOrder).toEqual(["promoted-prompt", "notification-b"]);
    expect(runtime.foregroundPromotionLease).toBeUndefined();
  });

  it("rejects idle-only acquisition while runtime work is pending", () => {
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;
    runtime.runtimeCommandQueue.enqueue(promptCommand("notification-b", "next"));

    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "auto-drain-bg43",
        mode: "idle-only",
        promotedInputId: "notification-b",
      }),
    ).toEqual({ kind: "busy" });
  });
});
