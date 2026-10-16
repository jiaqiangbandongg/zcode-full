import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "受控 CLI 进程暂停标记质量，强杀不补造 terminal",
  async () => {
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        contents: `
    import { LocalTtftRecorder } from "../src/zcode-protocol-v4/local-ttft.ts";
    const recorder = new LocalTtftRecorder(undefined, undefined, (fact) => process.send({ fact }));
    recorder.receive({ commandId: "process-input", clientId: "client", sessionId: "session", type: "sendText", payload: {}, issuedAt: Date.now(), ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" } }, false);
    recorder.admitted("process-input");
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      logLevel: "silent",
    });
    const child = spawn(process.execPath, [], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
    child.stdin!.end(bundle.outputFiles[0]!.text);
    const facts: Array<{ clockInvalid?: boolean; terminal?: string }> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("message", (message: { ready?: boolean; fact?: (typeof facts)[number] }) => {
          if (message.fact) facts.push(message.fact);
          if (message.ready) resolve();
        });
        child.once("exit", () => reject(new Error("worker exited before ready")));
      });
      child.kill("SIGSTOP");
      await delay(5200);
      child.kill("SIGCONT");
      await expect
        .poll(() => facts.some((fact) => fact.clockInvalid), { timeout: 3000 })
        .toBe(true);
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(facts.some((fact) => fact.terminal !== undefined)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
  15000,
);
