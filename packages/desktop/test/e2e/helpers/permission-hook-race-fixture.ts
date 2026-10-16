import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_WORKSPACE } from "./desktop-app.js";

export const PERMISSION_HOOK_RACE_MARKER = "E2E_PERMISSION_HOOK_RACE";
export const PERMISSION_HOOK_RACE_FINAL_MARKER =
  "E2E_PERMISSION_HOOK_RACE_DONE";
export const PERMISSION_HOOK_RACE_RESULT_CONTENT =
  "E2E_PERMISSION_HOOK_RACE_RESULT\n";

// Bug 根因：阻塞时长必须显著大于 spec 的终态等待窗口（60s），否则旧时序
// （hook 决出/超时后才注册 broker 应答通道）会以“慢通过”而不是失败暴露回归。
const BLOCKING_HOOK_SLEEP_MS = 120000;
const BLOCKING_HOOK_TIMEOUT_MS = 130000;

const WORKSPACE_ZCODE_DIR = join(DEFAULT_WORKSPACE, ".zcode");
const USER_CONFIG_DIR = join(dirname(DEFAULT_WORKSPACE), ".zcode", "cli");
const CONFIG_PATH = join(USER_CONFIG_DIR, "config.json");
const BLOCKER_PATH = join(
  WORKSPACE_ZCODE_DIR,
  "permission-hook-race-blocker.mjs",
);
const TRACE_PATH = join(WORKSPACE_ZCODE_DIR, "permission-hook-race-trace.jsonl");

let originalConfig: string | null = null;

export interface PermissionHookRaceTraceRecord
  extends Record<string, unknown> {
  phase?: string;
  hook_event_name?: string;
  tool_name?: string;
}

export async function installPermissionHookRaceFixture(): Promise<void> {
  await mkdir(WORKSPACE_ZCODE_DIR, { recursive: true });
  await mkdir(USER_CONFIG_DIR, { recursive: true });
  await rm(TRACE_PATH, { force: true });
  originalConfig = await readFile(CONFIG_PATH, "utf8").catch(
    (error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    },
  );
  const existing = originalConfig
    ? (JSON.parse(originalConfig) as Record<string, unknown>)
    : {};
  await writeFile(BLOCKER_PATH, BLOCKER_SOURCE, "utf8");

  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        ...existing,
        hooks: {
          enabled: true,
          timeoutMs: BLOCKING_HOOK_TIMEOUT_MS,
          maxOutputBytes: 32768,
          events: {
            PermissionRequest: [
              {
                matcher: "Write",
                hooks: [
                  {
                    type: "command",
                    // Bug 根因：project hooks 属于不可信可执行配置，CLI 安全策略
                    // 会主动忽略；必须写 user config 并使用隔离 E2E HOME 内的
                    // case-local 绝对路径。
                    command: `"${process.execPath}" "${BLOCKER_PATH}" "${TRACE_PATH}"`,
                    timeoutMs: BLOCKING_HOOK_TIMEOUT_MS,
                  },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function restorePermissionHookRaceFixture(): Promise<void> {
  if (originalConfig === null) {
    await rm(CONFIG_PATH, { force: true });
  } else {
    await writeFile(CONFIG_PATH, originalConfig, "utf8");
  }
  await rm(BLOCKER_PATH, { force: true });
  await rm(TRACE_PATH, { force: true });
}

export async function readPermissionHookRaceTrace(): Promise<
  PermissionHookRaceTraceRecord[]
> {
  try {
    return (await readFile(TRACE_PATH, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PermissionHookRaceTraceRecord);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export async function waitForBlockingHookStarted(
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const records = await readPermissionHookRaceTrace();
      return records.some(
        (record) =>
          record.phase === "started" &&
          record.hook_event_name === "PermissionRequest" &&
          record.tool_name === "Write",
      );
    },
    {
      timeout,
      timeoutMsg:
        "阻塞的 PermissionRequest hook 没有启动（竞速场景未成立，检查 hooks 配置是否生效）",
    },
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

// 事故场景复刻：hook 收到 PermissionRequest 输入后立即记录 started，然后
// 长时间阻塞、不输出任何决定。胜者收口后该子进程应被 abort（POSIX 收到
// SIGTERM 时补记 aborted；Windows 直接终止不保证信号处理，spec 不断言 aborted）。
const BLOCKER_SOURCE = String.raw`import { appendFileSync } from "node:fs";

const tracePath = process.argv[2];
const record = (phase, extra = {}) => {
  appendFileSync(
    tracePath,
    JSON.stringify({ phase, at: new Date().toISOString(), ...extra }) + "\n",
  );
};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
record("started", {
  hook_event_name: input.hook_event_name,
  tool_name: input.tool_name,
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    record("aborted", { signal });
    process.exit(143);
  });
}

await new Promise((resolveSleep) => setTimeout(resolveSleep, ${BLOCKING_HOOK_SLEEP_MS}));
record("settled-without-decision");
`;
