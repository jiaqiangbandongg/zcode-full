import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import { isTuiInvocation } from "../src/tui-stderr.js";
import type { RunDependencies } from "../src/run.js";

type CapturedWriteStream = NodeJS.WriteStream & {
  output: () => string;
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      writeCallback?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & { stderr: CapturedWriteStream; stdout: CapturedWriteStream } => ({
  argv,
  stderr: createWriteStream(),
  stdin: {
    isTTY: false,
  } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

const fakeProjection = {
  contextUsed: 0,
  contextWindow: 0,
  status: "idle",
  totalTokenCount: 0,
  turnCount: 1,
};

const createPromptDeps = (): RunDependencies => ({
  createZCodeApp: () => createPromptApp(),
  loadDotenv: () => ({
    keys: [],
    loaded: false,
  }),
  startProcessProviderRegistryRuntime: async () =>
    ({
      dispose: () => {},
      runtime: { registryService: {} },
    }) as never,
});

function createPromptApp(overrides: Record<string, unknown> = {}) {
  return {
    getModel: () => "openai/gpt-test",
    getThoughtLevel: () => "medium",
    sessionId: "session-test",
    traceId: "trace-test",
    runtime: {} as never,
    submitPrompt: async (prompt: string) => ({
      events: [],
      projection: fakeProjection as never,
      response: prompt,
      traceId: "trace-test" as never,
      turnId: "turn-test" as never,
    }),
    ...overrides,
  } as never;
}

test("recognizes --cwd as a default TUI invocation", () => {
  assert.equal(isTuiInvocation(["--cwd", "/workspace/project"]), true);
});

test("prints --cwd in help", async () => {
  const ctx = createContext(["--help"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /--cwd <path>/);
});

test("passes --cwd into prompt runtime config and dotenv loading", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-option-cwd-"));
  const ctx = createContext(["--cwd", cwd, "--prompt", "hello cwd option"]);

  try {
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      cwd: () => "/workspace/ignored",
      createZCodeApp: (options) => {
        assert.equal(options?.runtimeConfig?.workingDirectory, cwd);
        return createPromptApp();
      },
      loadDotenv: (options) => {
        assert.equal(options.cwd, cwd);
        return { keys: [], loaded: false };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(ctx.stdout.output(), "hello cwd option\n");
    assert.equal(ctx.stderr.output(), "");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("resolves relative --cwd from the process cwd provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-relative-cwd-"));
  const project = join(root, "project");
  const ctx = createContext(["--cwd", "project", "--prompt", "hello relative cwd"]);

  try {
    await mkdir(project);
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      cwd: () => root,
      createZCodeApp: (options) => {
        assert.equal(options?.runtimeConfig?.workingDirectory, project);
        return createPromptApp();
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(ctx.stdout.output(), "hello relative cwd\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses --cwd when resolving latest sessions for --continue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-continue-cwd-"));
  const ctx = createContext(["--cwd", cwd, "--continue", "--prompt", "hello continue cwd"]);
  let resolved = false;

  try {
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      cwd: () => "/workspace/ignored",
      resolveLatestSession: async (options) => {
        resolved = true;
        assert.equal(options.directory, cwd);
        return { id: "sess_latest" } as never;
      },
      createZCodeApp: (options) => {
        assert.equal(options?.runtimeConfig?.workingDirectory, cwd);
        assert.equal(options?.resume, true);
        assert.equal(options?.sessionId, "sess_latest");
        return createPromptApp({ sessionId: "sess_latest" });
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(resolved, true);
    assert.equal(ctx.stdout.output(), "hello continue cwd\n");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("passes --cwd into TUI app, skills, and session listing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-tui-cwd-"));
  const ctx = createContext(["--cwd", cwd, "tui"]);

  try {
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      cwd: () => "/workspace/ignored",
      createZCodeApp: (options) => {
        assert.equal(options?.runtimeConfig?.workingDirectory, cwd);
        return createPromptApp();
      },
      listSessions: async (options) => {
        assert.equal(options.directory, cwd);
        return [] as never;
      },
      listSkills: async (options) => {
        assert.equal(options.workingDirectory, cwd);
        return { diagnostics: [], skills: [], totalDiscovered: 0 } as never;
      },
      loadDotenv: (options) => {
        assert.equal(options.cwd, cwd);
        return { keys: [], loaded: false };
      },
      runTui: async (options) => {
        // 初始模型随 loadStartupOptions 在启动屏首帧后返回，App 也在此时按 --cwd 创建。
        const startup = { ...options, ...(await options.loadStartupOptions?.()) };
        assert.equal(startup.initialModel, "openai/gpt-test");
        assert.equal(options.workspaceDirectory, cwd);
        await options.submitPrompt("/skill", { abortSignal: new AbortController().signal });
        await options.submitPrompt("/resume", { abortSignal: new AbortController().signal });
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(ctx.stderr.output(), "");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("passes --cwd into skills JSON output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-skills-cwd-"));
  const ctx = createContext(["--cwd", cwd, "skills", "--json"]);

  try {
    const exitCode = await run(ctx, {
      cwd: () => "/workspace/ignored",
      listSkills: async (options) => {
        assert.equal(options.workingDirectory, cwd);
        return { diagnostics: [], skills: [], totalDiscovered: 0 } as never;
      },
    });
    const payload = JSON.parse(ctx.stdout.output()) as { cwd: string; totalDiscovered: number };

    assert.equal(exitCode, 0);
    assert.equal(payload.cwd, cwd);
    assert.equal(payload.totalDiscovered, 0);
    assert.equal(ctx.stderr.output(), "");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("prints --cwd in doctor JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-doctor-cwd-"));
  const ctx = createContext(["--cwd", cwd, "doctor", "--json"]);

  try {
    const exitCode = await run(ctx, { cwd: () => "/workspace/ignored" });
    const payload = JSON.parse(ctx.stdout.output()) as { runtime: { cwd: string } };

    assert.equal(exitCode, 0);
    assert.equal(payload.runtime.cwd, cwd);
    assert.equal(ctx.stderr.output(), "");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("passes --cwd into the app-server runner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-app-server-cwd-"));
  const ctx = createContext(["--cwd", cwd, "app-server", "--stdio"]);
  let called = false;
  let dotenvCalls = 0;

  try {
    const exitCode = await run(ctx, {
      cwd: () => "/workspace/ignored",
      loadDotenv: () => {
        dotenvCalls += 1;
        return { keys: [], loaded: false };
      },
      runZCodeProtocolAgent: async (options) => {
        called = true;
        assert.equal(options?.cwd, cwd);
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(called, true);
    assert.equal(dotenvCalls, 0);
    assert.equal(ctx.stderr.output(), "");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rejects inaccessible --cwd before creating an app", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-missing-cwd-"));
  const missing = join(root, "missing");
  const ctx = createContext(["--cwd", missing, "--prompt", "hello"]);
  let appCreated = false;

  try {
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      createZCodeApp: () => {
        appCreated = true;
        throw new Error("app should not be created");
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(appCreated, false);
    assert.match(ctx.stderr.output(), /--cwd path is not accessible/);
    assert.equal(ctx.stdout.output(), "");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects file --cwd before creating an app", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-file-cwd-"));
  const filePath = join(root, "file.txt");
  const ctx = createContext(["--cwd", filePath, "--prompt", "hello"]);
  let appCreated = false;

  try {
    await writeFile(filePath, "not a directory");
    const exitCode = await run(ctx, {
      ...createPromptDeps(),
      createZCodeApp: () => {
        appCreated = true;
        throw new Error("app should not be created");
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(appCreated, false);
    assert.match(ctx.stderr.output(), /--cwd must point to a directory/);
    assert.equal(ctx.stdout.output(), "");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
