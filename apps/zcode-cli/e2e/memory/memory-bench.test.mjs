import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "../compact-microcompact/scripted-provider.mjs";
import { classifyRequest, requestText } from "./memory-e2e-provider.mjs";
import { loadZCodeModules } from "./memory-e2e-runtime.mjs";

const artifactsRoot = await mkdtemp(join(tmpdir(), "zcode-memory-bench-artifacts-"));
const memoryContent =
  "E2E_MEMORY_BENCH_WRITTEN: Always require staging approval before deployment.";
const prompt = "E2E_MEMORY_BENCH Remember that every deployment requires staging approval.";
console.log(`Memory bench artifacts: ${artifactsRoot}`);

for (const scenario of ["wait", "default", "disabled", "cancel"]) {
  test(`CLI Memory bench: ${scenario}`, { timeout: 45_000 }, async (t) => {
    const runRoot = await mkdtemp(join(tmpdir(), "zcode-memory-bench-run-"));
    const workspace = join(runRoot, "workspace");
    const storageRoot = join(runRoot, "storage");
    const artifacts = join(artifactsRoot, scenario);
    await Promise.all([mkdir(workspace), mkdir(artifacts)]);
    const modules = await loadZCodeModules();
    const memoryRoot = modules.core.resolveProjectMemoryRoot({
      cliStorageRoot: join(storageRoot, "cli"),
      workspacePath: workspace,
    });
    const memoryFile = join(memoryRoot, "deployment.md");
    const extractionStarted = Promise.withResolvers();
    const releaseExtraction = Promise.withResolvers();
    const alive = Promise.withResolvers();
    const events = [];
    let extractionRequests = 0;
    let stdout = "";
    let stderr = "";
    let child;
    let exited;
    let outcome = { status: "failed" };
    const provider = await startScriptedProvider({
      name: `memory-bench-${scenario}`,
      handler: async ({ body }) => {
        const category = classifyRequest(body);
        events.push(`request:${category}`);
        if (category === "main")
          return response([{ type: "text", text: "E2E_MEMORY_BENCH_MAIN_DONE" }]);
        assert.equal(category, "extraction");
        extractionRequests += 1;
        if (requestText(body).includes(memoryContent))
          return response([{ type: "text", text: "Saved." }]);
        extractionStarted.resolve();
        await releaseExtraction.promise;
        return response([
          {
            type: "tool_use",
            id: "bench_write",
            name: "Write",
            input: { file_path: memoryFile, content: memoryContent },
          },
        ]);
      },
    });
    try {
      child = fork(
        fileURLToPath(new URL("./memory-bench-child.mjs", import.meta.url)),
        [
          JSON.stringify({
            argv: [
              "--verbose",
              "-p",
              prompt,
              ...(scenario === "default" ? [] : ["--memory-bench"]),
            ],
            baseURL: provider.baseURL,
            memoryEnabled: scenario !== "disabled",
            storageRoot,
            workspace,
          }),
        ],
        {
          execArgv: ["--disable-warning=DEP0205", "--import", "tsx"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      t.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("message", (message) => {
        events.push(message);
        if (message === "alive") alive.resolve();
      });
      exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          events.push("exit");
          resolve({ code, signal });
        });
      });
      if (scenario === "wait" || scenario === "cancel") {
        await Promise.race([
          extractionStarted.promise,
          exited.then((result) =>
            assert.fail(`premature exit ${JSON.stringify(result)}: ${stderr}`),
          ),
        ]);
        child.send("probe");
        await Promise.race([
          alive.promise,
          exited.then(() => assert.fail(`exited before liveness probe: ${stderr}`)),
        ]);
        assert.equal(child.exitCode, null);
        assert.ok(!events.includes("closing"));
        assert.ok(!stdout.includes("E2E_MEMORY_BENCH_MAIN_DONE"));
        if (scenario === "cancel") {
          child.kill("SIGTERM");
          const result = await exited;
          assert.ok(
            process.platform === "win32"
              ? result.signal === "SIGTERM" || result.code !== 0
              : result.code === 143,
          );
          releaseExtraction.resolve();
          await assert.rejects(readFile(memoryFile), { code: "ENOENT" });
        } else {
          events.push("release");
          releaseExtraction.resolve();
          assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
          assert.match(await readFile(memoryFile, "utf8"), /E2E_MEMORY_BENCH_WRITTEN/);
          assert.ok(events.indexOf("closing") > events.indexOf("release"));
          assert.equal(extractionRequests, 2);
          assert.match(stdout, /E2E_MEMORY_BENCH_MAIN_DONE/);
        }
      } else {
        assert.deepEqual(
          await exited,
          { code: scenario === "disabled" ? 1 : 0, signal: null },
          stderr,
        );
        assert.equal(extractionRequests, 0);
        if (scenario === "disabled") {
          assert.ok(!events.includes("request:main"));
          assert.match(stderr, /Memory.*enabled/i);
        }
        await assert.rejects(readFile(memoryFile), { code: "ENOENT" });
      }
      outcome = { status: "passed", extractionRequests };
    } finally {
      releaseExtraction.resolve();
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      provider.server.closeAllConnections();
      await stopScriptedProvider(provider);
      await Promise.all([
        writeScriptedCaptureFile(provider, join(artifacts, "provider-capture.json")),
        writeFile(join(artifacts, "result.json"), JSON.stringify({ ...outcome, events }, null, 2)),
        writeFile(join(artifacts, "stdout.txt"), stdout),
        writeFile(join(artifacts, "stderr.txt"), stderr),
        readFile(memoryFile, "utf8").then(
          (contents) => writeFile(join(artifacts, "deployment.md"), contents),
          () => {},
        ),
      ]);
      await rm(runRoot, { recursive: true, force: true });
    }
  });
}

function response(content) {
  return {
    body: {
      id: "memory-bench-response",
      type: "message",
      role: "assistant",
      model: "memory-bench-model",
      content,
      stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}
