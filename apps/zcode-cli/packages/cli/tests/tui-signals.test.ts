import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test(
  "built TUI survives SIGPIPE during startup and session replacement, but closes on SIGTERM",
  {
    skip: process.platform === "win32",
    timeout: 15_000,
  },
  async () => {
    const entry = new URL("../../tui/dist/index.js", import.meta.url);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { PassThrough, Writable } from "node:stream";
      import { setTimeout as delay } from "node:timers/promises";
      const { runTui } = await import(${JSON.stringify(entry.href)});
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
      const stdout = Object.assign(new Writable({ write(chunk, encoding, done) { done(); } }), {
        isTTY: true, columns: 110, rows: 32,
      });
      const startup = Promise.withResolvers();
      const ready = Promise.withResolvers();
      const submitted = Promise.withResolvers();
      let closed = false;
      const running = runTui({
        stdin, stdout, stderr: process.stderr, locale: "en-US", theme: "dark",
        loadStartupOptions: () => { startup.resolve(); return ready.promise; },
        submitPrompt: async (input) => {
          assert.equal(typeof input === "string" ? input : input.text, "/clear");
          // Closing an old session's pipes can deliver this signal to the TUI process.
          process.kill(process.pid, "SIGPIPE");
          submitted.resolve();
          return { response: "Started new session", resetSessionProjection: true };
        },
      }).then((code) => { closed = true; return code; });
      await startup.promise;
      process.kill(process.pid, "SIGPIPE");
      await delay(100);
      assert.equal(closed, false, "SIGPIPE must not close the startup screen");
      ready.resolve({});
      await delay(100);
      stdin.write("/clear");
      await delay(100);
      stdin.write("\\r");
      await submitted.promise;
      await delay(100);
      assert.equal(closed, false, "SIGPIPE must not close the new session");
      assert.ok(process.listenerCount("SIGTERM") > 0);
      process.kill(process.pid, "SIGTERM");
      assert.equal(await running, 0);
      process.stdout.write("TUI signal lifecycle passed\\n");
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../tui", import.meta.url)),
        env: { ...process.env, NODE_OPTIONS: "" },
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(stdout, /TUI signal lifecycle passed/);
  },
);
