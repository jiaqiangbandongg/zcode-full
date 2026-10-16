import { describe, expect, it } from "vitest";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";

describe("remoteConnectionProgressContext", () => {
  it("并发远程连接按 requestId 隔离进度，连接结束后停止上报残留异步日志", async () => {
    const events: Array<{ requestId: string; message: string }> = [];
    const context = createRemoteConnectionProgressContext({
      emit: (event) => events.push({ requestId: event.requestId, message: String(event.args[0]) }),
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = context.run("connect-first", async () => {
      context.report("info", ["first-start"]);
      await firstGate;
      context.report("info", ["first-end"]);
      setTimeout(() => context.report("info", ["first-stale"]), 0);
    });
    const second = context.run("connect-second", async () => {
      context.report("info", ["second-start"]);
      await secondGate;
      context.report("info", ["second-end"]);
    });

    releaseSecond();
    await second;
    releaseFirst();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([
      { requestId: "connect-first", message: "first-start" },
      { requestId: "connect-second", message: "second-start" },
      { requestId: "connect-second", message: "second-end" },
      { requestId: "connect-first", message: "first-end" },
    ]);
  });
});
