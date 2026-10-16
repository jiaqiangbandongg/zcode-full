import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  resolveE2EHomeDir,
  resolveE2ERuntimePath,
  resolveE2EStorageRoot,
} from "./e2e-runtime-paths.js";

const CASE_NAME = "conversation-session-stop-tool-results";
const runtimeRoot = resolveE2ERuntimePath(CASE_NAME);
const configPath = join(resolveE2EStorageRoot(), "cli", "config.json");
const tracePath = join(runtimeRoot, "hook-trace.jsonl");
const hookPath = join(runtimeRoot, "block-read.mjs");
const bashHookPath = join(runtimeRoot, "block-text-bash.mjs");
const releasePath = join(runtimeRoot, "release-text-bash");
const fileFixtureRoot = resolve("test/e2e/fixtures/fs/conversation-session", CASE_NAME);
let originalConfig: string | null = null;

export interface StopToolLogRecord {
  timestamp: string;
  event: string;
  module?: string;
  sessionId?: string;
  toolCallId?: string;
  status?: string;
  error?: unknown;
  context?: { sessionEventType?: string };
}

interface HookTrace {
  hook_event_name: string;
  session_id: string;
  tool_use_id: string;
  phase: string;
}

export async function installStopToolResultsFixture(): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  originalConfig = await readOptionalFile(configPath);
  await rm(tracePath, { force: true });
  await rm(releasePath, { force: true });
  await Promise.all(
    [
      "first.txt",
      "first.png",
      "blocked-2.txt",
      "blocked-3.txt",
      "block-read.mjs",
      "block-text-bash.mjs",
    ].map((name) => copyFile(join(fileFixtureRoot, name), join(runtimeRoot, name))),
  );
  const config = originalConfig ? JSON.parse(originalConfig) : {};
  // 项目 Hook 不可信，会被正常安全策略忽略；只在隔离 HOME 写入用户 Hook，
  // 用真实 PreToolUse 固定两个 Read 的取消窗口，不改 executor 或历史。
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...config,
        hooks: {
          enabled: true,
          timeoutMs: 120000,
          events: {
            PreToolUse: [
              {
                matcher: "Read",
                hooks: [
                  {
                    type: "process",
                    command: process.execPath,
                    args: [hookPath, tracePath],
                    timeoutMs: 120000,
                  },
                ],
              },
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "process",
                    command: process.execPath,
                    args: [bashHookPath, tracePath, releasePath],
                    timeoutMs: 120000,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "process",
                    command: process.execPath,
                    args: [bashHookPath, tracePath, releasePath],
                    timeoutMs: 120000,
                  },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
}

export async function waitForTextBashBarrier(sessionId: string, toolId: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const logs = await readStopToolLogs(sessionId);
      const trace = (await readOptionalFile(tracePath)) ?? "";
      return (
        logs.some(
          (record) =>
            record.event === "model.request.completed" && record.module === "core.runtime",
        ) &&
        trace
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const record = JSON.parse(line) as HookTrace;
            return (
              record.session_id === sessionId &&
              record.tool_use_id === toolId &&
              record.phase === "text_bash_completed"
            );
          })
      );
    },
    { timeout: 45000, timeoutMsg: "纯文本 Bash 未到达模型完成后的 PostToolUse barrier" },
  );
}

export function holdToolResultDatabaseWriteLock(): () => void {
  // Node 内置 SQLite 只提供同步连接；仅对本次隔离 E2E 数据库持锁，不写会话数据。
  const database = new DatabaseSync(join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"));
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  };
}

export async function releaseTextBashHook(): Promise<void> {
  await writeFile(releasePath, "release");
}

export async function resetTextBashHook(): Promise<void> {
  await rm(releasePath, { force: true });
}

export async function restoreStopToolResultsFixture(): Promise<void> {
  if (originalConfig === null) await rm(configPath, { force: true });
  else await writeFile(configPath, originalConfig);
  await rm(runtimeRoot, { recursive: true, force: true });
}

export async function readStopToolLogs(sessionId: string): Promise<StopToolLogRecord[]> {
  const logDir =
    process.env.ZCODE_LOG_DIR?.trim() ||
    join(resolveE2EStorageRoot(resolveE2EHomeDir()), "cli", "log");
  const names = await readdir(logDir);
  const contents = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(join(logDir, name), "utf8")),
  );
  return contents
    .flatMap((content) => content.split("\n").slice(0, -1))
    .filter((line) => line.includes(sessionId))
    .map((line) => JSON.parse(line) as StopToolLogRecord)
    .filter((record) => record.sessionId === sessionId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function waitForStopToolBarrier(
  sessionId: string,
  toolIds: readonly string[],
): Promise<void> {
  let logs: StopToolLogRecord[] = [];
  let hooks: HookTrace[] = [];
  await browser.waitUntil(
    async () => {
      logs = await readStopToolLogs(sessionId);
      hooks = ((await readOptionalFile(tracePath)) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HookTrace);
      const firstCompleted = logs.some(
        (record) => record.event === "tool.call.completed" && record.toolCallId === toolIds[0],
      );
      const modelCompleted = logs.some(
        (record) => record.event === "model.request.completed" && record.module === "core.runtime",
      );
      const othersBlocked = toolIds
        .slice(1)
        .every((id) =>
          hooks.some(
            (record) =>
              record.session_id === sessionId &&
              record.tool_use_id === id &&
              record.phase === "blocked",
          ),
        );
      return firstCompleted && modelCompleted && othersBlocked;
    },
    { timeout: 45000, timeoutMsg: "未建立 Read 成功 + 模型完成 + 两个 Read Hook 挂起的 Stop 窗口" },
  );
  // 必须仍有未结算工具；否则 Stop 命中的是空闲态，无法证明取消收尾链路。
  expect(
    logs.filter(
      (record) =>
        toolIds.slice(1).includes(record.toolCallId ?? "") &&
        ["tool.call.completed", "tool.call.failed"].includes(record.event),
    ),
  ).toHaveLength(0);
}

export async function writeStopToolEvidence(
  variant: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const directory = join(
    process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() || resolve(".e2e-artifacts"),
    CASE_NAME,
  );
  await mkdir(directory, { recursive: true });
  const sessionId = evidence.sessionId;
  const modelIo =
    typeof sessionId === "string"
      ? ((await readOptionalFile(
          join(resolveE2EStorageRoot(), "cli", "rollout", `model-io-${sessionId}.jsonl`),
        )) ??
        (await readOptionalFile(
          join(resolveE2EStorageRoot(), "cli", "debug", `model-io-${sessionId}.jsonl`),
        )))
      : null;
  if (modelIo) await writeFile(join(directory, `${variant}-model-io.jsonl`), modelIo);
  await writeFile(
    join(directory, `${variant}.json`),
    JSON.stringify(
      {
        ...evidence,
        hookTrace: await readOptionalFile(tracePath),
      },
      null,
      2,
    ),
  );
  await browser.saveScreenshot(join(directory, `${variant}.png`));
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
