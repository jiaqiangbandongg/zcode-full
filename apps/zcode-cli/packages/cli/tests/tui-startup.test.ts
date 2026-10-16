import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import React from "react";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { CliRenderEvents } from "@mbears/opentui-core";
import type { UiThemeMode } from "@zcode/contracts";
import { runTuiWithRenderer } from "../../tui/src/tui.js";
import { getActiveTuiThemeMode } from "../../tui/src/theme/state.js";
import type { TuiOptions, TuiStartupOptions } from "../../tui/src/types.js";
import { runTuiCommand } from "../src/tui-command.js";
import type { RunDependencies } from "../src/cli-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseOptions: TuiOptions = {
  noColor: true,
  locale: "en-US",
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  workspaceDirectory: "/test/workspace",
  submitPrompt: async () => ({ response: "" }),
};

async function terminalFixture(
  options: Partial<TuiOptions>,
  configure?: (terminal: Awaited<ReturnType<typeof createTestRenderer>>) => void,
  closeBeforePaint = false,
) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    width: 110,
    height: 32,
    targetFps: 30,
    screenMode: "alternate-screen",
    useThread: false,
  });
  const theme = deferred<UiThemeMode>();
  terminal.renderer.waitForThemeMode = () => theme.promise;
  configure?.(terminal);
  let outcome!: Promise<number | Error>;
  await React.act(async () => {
    outcome = runTuiWithRenderer({ ...baseOptions, ...options }, terminal.renderer).catch(
      (error: Error) => error,
    );
    if (closeBeforePaint) terminal.renderer.destroy();
  });
  return {
    ...terminal,
    theme,
    outcome,
    async action(work: () => void | Promise<void>) {
      await React.act(async () => {
        await work();
      });
      if (!terminal.renderer.isDestroyed) {
        await React.act(async () => {
          await terminal.renderOnce();
        });
      }
    },
    async close() {
      await React.act(async () => {
        theme.resolve("dark");
        if (!terminal.renderer.isDestroyed) terminal.renderer.destroy();
      });
      await outcome;
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

test("native first paint precedes initialization and theme detection; ready options reach the app", async () => {
  const startup = deferred<TuiStartupOptions>();
  let frameAtStartup = "";
  let capture = () => "";
  let calls = 0;
  const terminal = await terminalFixture(
    {
      loadStartupOptions: () => {
        calls += 1;
        frameAtStartup = capture();
        return startup.promise;
      },
    },
    (created) => {
      capture = created.captureCharFrame;
    },
  );
  try {
    await terminal.action(() => terminal.renderOnce());
    assert.equal(calls, 1);
    assert.match(frameAtStartup, /Starting ZCode/);
    assert.match(terminal.captureCharFrame(), /\/test\/workspace/);
    assert.doesNotMatch(terminal.captureCharFrame(), /Type a prompt/);
    await terminal.action(() =>
      startup.resolve({
        initialModel: "personal/startup-model",
        initialThoughtLevel: "high",
        initialMode: "plan",
        theme: "dark",
        loginRequired: false,
        slashCommands: [
          { name: "startup-command", summary: "Loaded command", usage: "/startup-command" },
        ],
      }),
    );
    assert.doesNotMatch(terminal.captureCharFrame(), /Starting ZCode/);
    assert.match(terminal.captureCharFrame(), /startup-model/);
    assert.match(terminal.captureCharFrame(), /personal \| high/);
    await terminal.action(() => terminal.mockInput.typeText("/startup"));
    assert.match(terminal.captureCharFrame(), /startup-command/);
    await terminal.action(() => terminal.theme.resolve("light"));
    assert.equal(
      getActiveTuiThemeMode(),
      "dark",
      "late terminal detection preserves explicit theme",
    );
    assert.equal(calls, 1);
  } finally {
    await terminal.close();
  }
});

test("Ctrl+C closes the startup screen and ignores late completion", async () => {
  const startup = deferred<TuiStartupOptions>();
  let appQueries = 0;
  const terminal = await terminalFixture({
    loadStartupOptions: () => startup.promise,
    listMcpServers: async () => {
      appQueries += 1;
      return {};
    },
  });
  try {
    await terminal.action(() => terminal.renderOnce());
    await terminal.action(() => terminal.mockInput.pressCtrlC());
    assert.equal(await terminal.outcome, 130);
    await terminal.action(() => startup.resolve({ initialModel: "late/model" }));
    assert.equal(appQueries, 0);
    assert.equal(terminal.renderer.listenerCount(CliRenderEvents.FRAME), 0);
  } finally {
    await terminal.close();
  }
});

test("fatal startup errors restore the terminal and propagate the original failure", async () => {
  const startup = deferred<TuiStartupOptions>();
  const terminal = await terminalFixture({ loadStartupOptions: () => startup.promise });
  const failure = new Error("Storage migration failed");
  failure.name = "SqliteSessionMigrationError";
  try {
    await terminal.action(() => terminal.renderOnce());
    await terminal.action(() => startup.reject(failure));
    assert.equal(await terminal.outcome, failure);
    assert.equal(terminal.renderer.isDestroyed, true);
  } finally {
    await terminal.close();
  }
});

test("closing before the first paint never starts runtime initialization", async () => {
  let calls = 0;
  const terminal = await terminalFixture(
    {
      loadStartupOptions: async () => {
        calls += 1;
        return {};
      },
    },
    undefined,
    true,
  );
  await terminal.close();
  assert.equal(calls, 0);
});

test("CLI defers initialization to the renderer and discovers commands and Git concurrently", async () => {
  const created = deferred<unknown>();
  const observed: string[] = [];
  let closed = 0;
  const app = {
    getModel: () => "personal/ready",
    getThoughtLevel: () => "high",
    getLocale: () => "en-US",
    getTheme: () => "dark",
    listModels: () => [],
    listThoughtLevels: () => ["high"],
    close: async () => {
      closed += 1;
    },
  };
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    createZCodeApp: async () => {
      observed.push("app");
      return created.promise;
    },
    startProcessProviderRegistryRuntime: async () => ({
      runtime: { registryService: {} },
      dispose() {},
    }),
    resolveWorkspaceGitBranch: async () => {
      observed.push("git");
      return "test-branch";
    },
    listCustomCommands: async () => {
      observed.push("commands");
      return { commands: [], diagnostics: [], totalDiscovered: 0 };
    },
    runTui: async (options: TuiOptions) => {
      assert.deepEqual(observed, []);
      const ready = options.loadStartupOptions!();
      assert.ok(observed.includes("commands"));
      assert.ok(observed.includes("git"));
      created.resolve(app);
      const startup = await ready;
      assert.equal(startup.initialModel, "personal/ready");
      assert.equal(startup.initialThoughtLevel, "high");
      assert.equal(startup.workspaceGitBranch, "test-branch");
      assert.equal(startup.theme, "dark");
      return 0;
    },
  } as unknown as RunDependencies;
  assert.equal(
    await runTuiCommand(
      { argv: [], stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
      { noColor: true, force: false, json: false, verbose: false, locale: "en-US" },
      deps,
      "test",
    ),
    0,
  );
  assert.equal(observed.filter((entry) => entry === "app").length, 1);
  assert.equal(closed, 1);
});

test("built TUI loads in plain Node without a TypeScript loader", async () => {
  const entry = new URL("../../tui/dist/index.js", import.meta.url);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const tui = await import(${JSON.stringify(entry.href)}); console.log(typeof tui.runTui);`,
    ],
    {
      cwd: fileURLToPath(new URL("../../tui", import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(stdout.trim(), "function");
});
