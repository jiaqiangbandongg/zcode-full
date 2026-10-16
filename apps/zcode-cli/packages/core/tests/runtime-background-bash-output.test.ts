import { describe, expect, it, vi } from "vitest";
import { readBackgroundBashOutput } from "../src/runtime/methods/background-bash-output.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

describe("background Bash execution owner routing", () => {
  it.each([undefined, "child"])(
    "passes the actual owning session to the execution boundary (%s)",
    async (sessionId) => {
      const read = vi.fn().mockResolvedValue({ kind: "unavailable", workId: "work" });
      const runtime = {
        sessionId: "root",
        executionPort: { readBackgroundBashOutput: read },
      } as unknown as AgentRuntimeInternal;
      expect(await readBackgroundBashOutput.call(runtime, "work", sessionId)).toEqual({
        kind: "unavailable",
        workId: "work",
      });
      expect(read).toHaveBeenCalledExactlyOnceWith("work", sessionId ?? "root");
    },
  );
  it("reports unsupported without creating an execution port", async () => {
    const runtime = { sessionId: "root" } as unknown as AgentRuntimeInternal;
    expect(await readBackgroundBashOutput.call(runtime, "work")).toEqual({
      kind: "unsupported",
      workId: "work",
    });
  });
});
