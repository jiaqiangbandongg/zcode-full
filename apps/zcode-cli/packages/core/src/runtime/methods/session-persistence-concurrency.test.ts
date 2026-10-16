import { expect, it, vi } from "vitest";
import { ensureSessionPersisted } from "./events.js";
import type { AgentRuntimeInternal } from "../internal.js";
it("merges first sampling and main-task persistence; a failed attempt can be retried", async () => {
  const gate = Promise.withResolvers<never>();
  const createSession = vi.fn(() => gate.promise);
  const runtime = {
    sessionStore: { createSession },
    sessionPersisted: false,
    config: { mode: "build" },
    workingDirectory: "/fixture",
    sessionId: "task",
  } as unknown as AgentRuntimeInternal;
  const trace = { traceId: "trace", spanId: "span" } as never;
  const a = ensureSessionPersisted.call(runtime, "sampling", trace);
  const b = ensureSessionPersisted.call(runtime, "main", trace);
  const outcomes = Promise.allSettled([a, b]);
  expect(createSession).toHaveBeenCalledTimes(1);
  gate.reject(new Error("fixture storage failed"));
  expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
  await expect(ensureSessionPersisted.call(runtime, "retry", trace)).rejects.toThrow(
    "storage failed",
  );
  expect(createSession).toHaveBeenCalledTimes(2);
});
