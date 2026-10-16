import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";
import { createCommandCenter, listSlashCommandSuggestions } from "../src/command-center.js";
import type { CommandCenterApp, CommandCenterDeps } from "../src/command-center.js";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { WORKFLOW_DISABLED_NOTICE, WORKFLOW_MODE_SCOPE_ERROR } from "../src/workflow-mode.js";

/**
 * 独立 CLI 的 `--workflow-mode`（docs/dynamic-workflow/launch.md「The standalone CLI:
 * `--workflow-mode`」，DWG-14 ～ DWG-17）。缺省 disabled；两个 runtime 字段总是显式写出。
 */

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    isTTY: false,
    output: () => output,
    write: (chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      (done as (() => void) | undefined)?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (argv: string[]) =>
  ({
    argv,
    stderr: createWriteStream(),
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: createWriteStream(),
  }) satisfies RunContext;

const fakeProjection = {
  contextUsed: 0,
  contextWindow: 0,
  status: "idle",
  totalTokenCount: 0,
  turnCount: 1,
};

type RuntimeConfigSeen = {
  dynamicWorkflowEnabled?: boolean;
  dynamicWorkflowToolsOnDemand?: boolean;
};

/** 记录每次建 app 时的两个工作流字段；app 本身只够跑通一次 prompt / TUI 启动。 */
function createRecordingDeps(): { deps: RunDependencies; seen: RuntimeConfigSeen[] } {
  const seen: RuntimeConfigSeen[] = [];
  const deps: RunDependencies = {
    createModelAdapter: () => ({}) as never,
    createZCodeApp: (options) => {
      const config = (options?.runtimeConfig ?? {}) as RuntimeConfigSeen;
      seen.push({
        dynamicWorkflowEnabled: config.dynamicWorkflowEnabled,
        dynamicWorkflowToolsOnDemand: config.dynamicWorkflowToolsOnDemand,
      });
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: `session-${seen.length}`,
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({ dispose: () => {}, runtime: { registryService: {} } }) as never,
    skipUserConfig: true,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }) as never,
  };
  return { deps, seen };
}

const DISABLED_PAIR = { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: false };
const ON_DEMAND_PAIR = { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true };
const ALWAYS_ON_PAIR = { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: false };

// ── DWG-14：取值与 runtime 字段 ────────────────────────────────────────────

test("headless prompt without --workflow-mode writes the disabled pair explicitly", async () => {
  const { deps, seen } = createRecordingDeps();
  const ctx = createContext(["--prompt", "hello"]);
  assert.equal(await run(ctx, deps), 0);
  assert.deepEqual(seen, [DISABLED_PAIR]);
});

for (const [mode, pair] of [
  ["disabled", DISABLED_PAIR],
  ["onDemand", ON_DEMAND_PAIR],
  ["alwaysOn", ALWAYS_ON_PAIR],
] as const) {
  test(`headless prompt with --workflow-mode ${mode} writes the matching pair`, async () => {
    const { deps, seen } = createRecordingDeps();
    const ctx = createContext(["--prompt", "hello", "--workflow-mode", mode]);
    assert.equal(await run(ctx, deps), 0);
    assert.deepEqual(seen, [pair]);
  });
}

test("TUI without --workflow-mode writes the disabled pair and suggests no /workflow", async () => {
  const { deps, seen } = createRecordingDeps();
  let suggestions: string[] = [];
  const ctx = createContext(["tui"]);
  const exitCode = await run(ctx, {
    ...deps,
    runTui: async (options) => {
      // TUI 的斜杠命令与首个 App 由启动选项异步提供（TUI 启动画面先渲染，再加载会话元数据）。
      const startup = await options.loadStartupOptions?.();
      suggestions = (startup?.slashCommands ?? options.slashCommands ?? []).map(
        (entry) => entry.name,
      );
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(seen.length > 0, "the TUI creates its first app at startup");
  for (const config of seen) assert.deepEqual(config, DISABLED_PAIR);
  assert.ok(!suggestions.includes("workflow"));
  assert.ok(suggestions.includes("dwf"), "/dwf stays for viewing existing runs");
});

test("TUI with --workflow-mode onDemand writes the onDemand pair and suggests /workflow", async () => {
  const { deps, seen } = createRecordingDeps();
  let suggestions: string[] = [];
  const ctx = createContext(["--workflow-mode", "onDemand"]);
  const exitCode = await run(ctx, {
    ...deps,
    runTui: async (options) => {
      // TUI 的斜杠命令与首个 App 由启动选项异步提供（TUI 启动画面先渲染，再加载会话元数据）。
      const startup = await options.loadStartupOptions?.();
      suggestions = (startup?.slashCommands ?? options.slashCommands ?? []).map(
        (entry) => entry.name,
      );
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(seen.length > 0);
  for (const config of seen) assert.deepEqual(config, ON_DEMAND_PAIR);
  assert.ok(suggestions.includes("workflow"));
});

test("every app the TUI creates, including /new, carries the same pair", async () => {
  const { deps, seen } = createRecordingDeps();
  const handler = createTuiSubmitPrompt(
    deps,
    {},
    "test",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    "alwaysOn",
  );
  try {
    await handler.getSessionMetadata!();
    await handler("/new", { abortSignal: new AbortController().signal });
  } finally {
    await handler.close?.();
  }
  assert.equal(seen.length, 2);
  for (const config of seen) assert.deepEqual(config, ALWAYS_ON_PAIR);
});

test("an unknown --workflow-mode value fails before any app is created", async () => {
  const { deps, seen } = createRecordingDeps();
  const ctx = createContext(["--prompt", "hello", "--workflow-mode", "sometimes"]);
  assert.equal(await run(ctx, deps), 1);
  assert.match(
    ctx.stderr.output(),
    /Unsupported --workflow-mode value: sometimes\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
  assert.deepEqual(seen, []);
});

// ── DWG-15：作用域 ──────────────────────────────────────────────────────────

for (const argv of [["app-server"], ["agent-server"], ["login"], ["skills"]] as const) {
  test(`--workflow-mode is rejected with ${argv[0]}`, async () => {
    const { deps, seen } = createRecordingDeps();
    const ctx = createContext([...argv, "--workflow-mode", "alwaysOn"]);
    assert.equal(await run(ctx, deps), 1);
    assert.equal(ctx.stderr.output(), `${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    assert.deepEqual(seen, []);
  });
}

test("--workflow-mode is accepted with --target", async () => {
  const ctx = createContext(["--target", "ship it", "--workflow-mode", "alwaysOn"]);
  let seenPair: RuntimeConfigSeen | undefined;
  const exitCode = await run(ctx, {
    ...createRecordingDeps().deps,
    createZCodeApp: (options) => {
      const config = (options?.runtimeConfig ?? {}) as RuntimeConfigSeen;
      seenPair = {
        dynamicWorkflowEnabled: config.dynamicWorkflowEnabled,
        dynamicWorkflowToolsOnDemand: config.dynamicWorkflowToolsOnDemand,
      };
      throw new Error("stop after app options were checked");
    },
  });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(ctx.stderr.output(), /can only be used/);
  assert.deepEqual(seenPair, ALWAYS_ON_PAIR);
});

// ── DWG-17：headless ─────────────────────────────────────────────────────────

test("headless /workflow under the default mode exits 1 before any app exists", async () => {
  const { deps, seen } = createRecordingDeps();
  const ctx = createContext(["--prompt", "/workflow build me a plan"]);
  assert.equal(await run(ctx, deps), 1);
  assert.equal(ctx.stderr.output(), `Error: ${WORKFLOW_DISABLED_NOTICE}\n`);
  assert.equal(ctx.stdout.output(), "");
  assert.deepEqual(seen, []);
});

test("headless /help lists /workflow only when workflows are on", async () => {
  const disabled = createContext(["--prompt", "/help"]);
  assert.equal(await run(disabled, createRecordingDeps().deps), 0);
  assert.doesNotMatch(disabled.stdout.output(), /\/workflow/);
  assert.match(disabled.stdout.output(), /\/dwf/);

  const onDemand = createContext(["--prompt", "/help", "--workflow-mode", "onDemand"]);
  assert.equal(await run(onDemand, createRecordingDeps().deps), 0);
  assert.match(onDemand.stdout.output(), /\/workflow \[what the workflow should accomplish\]/);
});

// ── DWG-16：命令面 ───────────────────────────────────────────────────────────

function createHarness(
  workflowMode: CommandCenterDeps["workflowMode"],
  app: Partial<CommandCenterApp> = {},
) {
  const calls = { getApp: 0, submitted: [] as string[] };
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      calls.getApp += 1;
      return {
        sessionId: "sess_active",
        traceId: "trace-active",
        submitPrompt: async (prompt: string) => {
          calls.submitted.push(prompt);
          return { response: "submitted", traceId: "trace-submit" };
        },
        ...app,
      } as never;
    },
    getMode: () => "build" as never,
    resumeApp: async () => {
      throw new Error("resumeApp should not run");
    },
    workflowMode,
  });
  return { calls, submitPrompt };
}

const ABORT = { abortSignal: new AbortController().signal };

test("disabled: /workflow answers the notice locally without an app or a model turn", async () => {
  const { calls, submitPrompt } = createHarness("disabled");
  const result = await submitPrompt("/workflow review the auth module", ABORT);
  assert.equal(result.response, WORKFLOW_DISABLED_NOTICE);
  assert.equal(calls.getApp, 0);
  assert.deepEqual(calls.submitted, []);
});

test("disabled: /help and /help workflow leave /workflow out", async () => {
  const { submitPrompt } = createHarness("disabled");
  const all = await submitPrompt("/help", ABORT);
  assert.doesNotMatch(all.response, /\/workflow/);
  const single = await submitPrompt("/help workflow", ABORT);
  assert.match(single.response, /^Unknown slash command: \/workflow\./);
  assert.doesNotMatch(single.response, /Available commands:.*\/workflow\b/);
});

test("disabled: /dwf list and cancel still work, resume is refused before the server", async () => {
  let resumed = 0;
  let cancelled = 0;
  const { submitPrompt } = createHarness("disabled", {
    listDynamicWorkflowRuns: async () => [],
    cancelBackgroundTask: async () => {
      cancelled += 1;
      return { cancelled: true, status: "cancelled" } as never;
    },
    resumeWorkflowRun: async () => {
      resumed += 1;
      return { ok: true, runId: "dwfrun_1" } as never;
    },
  });

  assert.match((await submitPrompt("/dwf list", ABORT)).response, /No dynamic workflow runs/);
  assert.match(
    (await submitPrompt("/dwf cancel dwfrun_1", ABORT)).response,
    /Cancelled dynamic workflow run dwfrun_1/,
  );
  assert.equal(cancelled, 1);
  assert.equal(
    (await submitPrompt("/dwf resume dwfrun_1", ABORT)).response,
    WORKFLOW_DISABLED_NOTICE,
  );
  assert.equal(resumed, 0);
});

for (const mode of ["onDemand", "alwaysOn"] as const) {
  test(`${mode}: /workflow is suggested and submitted to the app as before`, async () => {
    const { calls, submitPrompt } = createHarness(mode);
    const result = await submitPrompt("/workflow review the auth module", ABORT);
    assert.equal(result.response, "submitted");
    assert.deepEqual(calls.submitted, ["/workflow review the auth module"]);
    const names = listSlashCommandSuggestions(undefined, { workflowMode: mode }).map(
      (entry) => entry.name,
    );
    assert.ok(names.includes("workflow"));
  });
}

test("disabled: the suggestion list drops only /workflow", () => {
  const all = listSlashCommandSuggestions().map((entry) => entry.name);
  const disabled = listSlashCommandSuggestions(undefined, { workflowMode: "disabled" }).map(
    (entry) => entry.name,
  );
  assert.deepEqual(
    disabled,
    all.filter((name) => name !== "workflow"),
  );
});
