import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { NodeExecutionAdapterProcess } from "../src/exec/node-execution-adapter-process.js";
import { BASH_SIGTERM_TO_SIGKILL_MS, signalPosixProcessTree } from "../src/exec/process-tree.js";

vi.mock("../src/exec/process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/exec/process-tree.js")>()),
  signalPosixProcessTree: vi.fn(),
}));

class StopTestAdapter extends NodeExecutionAdapterProcess {
  stopBash(): void {
    this.terminateProcessTree({ pid: 12345 } as ChildProcess, true);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("waits for asynchronous SIGKILL dispatch, not just its escalation timer", async () => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
  let finishDispatch!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  vi.mocked(signalPosixProcessTree).mockImplementation((_pid, signal) =>
    signal === "SIGKILL" ? dispatch : Promise.resolve(),
  );
  const adapter = new StopTestAdapter({ platform: "linux" });
  let closed = false;
  adapter.stopBash();
  const closing = adapter.close().then(() => {
    closed = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(BASH_SIGTERM_TO_SIGKILL_MS);
    expect(signalPosixProcessTree).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(closed).toBe(false);
    finishDispatch();
    await closing;
    expect(closed).toBe(true);
  } finally {
    finishDispatch();
    await closing;
  }
});
