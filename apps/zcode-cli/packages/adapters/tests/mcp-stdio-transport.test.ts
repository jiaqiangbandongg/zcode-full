import { describe, expect, it } from "vitest";
import { ProcessTreeStdioClientTransport } from "../src/mcp/stdio-transport.js";

describe("ProcessTreeStdioClientTransport", () => {
  it("retains the direct child exit code for crash telemetry", async () => {
    const transport = new ProcessTreeStdioClientTransport({
      args: ["-e", "process.exit(7)"],
      command: process.execPath,
      stderr: "ignore",
    });
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });

    await transport.start();
    await closed;

    expect(transport.processExit).toMatchObject({
      exitCode: 7,
      signal: null,
    });
    expect(transport.processExit?.exitedAt).toBeGreaterThanOrEqual(
      transport.processExit?.startedAt ?? Number.POSITIVE_INFINITY,
    );
  });
});
