import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runProxyStdio } from "../src/server-core/proxyStdio.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

async function writeReadyStatus(serverRoot: string, port: number): Promise<void> {
  const layout = resolveServerLayout(serverRoot);
  await mkdir(layout.runDir, { recursive: true });
  await writeFile(
    layout.statusFile,
    JSON.stringify({
      protocolVersion: 1,
      state: "ready",
      pid: process.pid,
      port,
      host: "127.0.0.1",
      version: "3.8.0",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
      updatedAt: Date.now(),
    }),
  );
}

describe("server proxy-stdio", () => {
  it("forwards arbitrary bytes between stdio and the ready loopback daemon", async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const address = echo.address();
    if (!address || typeof address === "string") throw new Error("missing echo port");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-stdio-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeReadyStatus(layout.serverRoot, address.port);
    const input = new PassThrough();
    const output = new PassThrough();
    const received: Buffer[] = [];
    output.on("data", (chunk) => received.push(Buffer.from(chunk)));
    const payload = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]);

    const forwarding = runProxyStdio({ layout, input, output });
    input.end(payload);
    await forwarding;
    await new Promise<void>((resolve) => echo.close(() => resolve()));

    expect(Buffer.concat(received)).toEqual(payload);
  });

  it("fails before writing channel bytes when daemon status is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-stdio-missing-"));
    const layout = resolveServerLayout(join(root, "server"));
    await expect(
      runProxyStdio({
        layout,
        input: new PassThrough(),
        output: new PassThrough(),
      }),
    ).rejects.toMatchObject({ code: "daemon-not-ready" });
  });
});
