import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_WORKSPACE } from "./desktop-app.js";

export const HOOKS_CASE_MARKERS = {
  earlyFailures: "E2E_HOOKS_EARLY_FAILURES",
  fullChain: "E2E_HOOKS_FULL_CHAIN",
  promptError: "E2E_HOOKS_PROMPT_ERROR",
  promptBlock: "E2E_HOOKS_PROMPT_BLOCK",
  stopCap: "E2E_HOOKS_STOP_CAP",
} as const;

export const HOOKS_FINAL_MARKERS = {
  earlyFailures: `${HOOKS_CASE_MARKERS.earlyFailures}_OK`,
  fullChain: `${HOOKS_CASE_MARKERS.fullChain}_OK`,
} as const;

export const HOOKS_CONTEXT = {
  asyncIgnored: "HOOK_ASYNC_CONTEXT_MUST_BE_IGNORED",
  failure: "HOOK_POST_FAILURE_CONTEXT",
  invalidUpdate: "HOOK_PRE_INVALID_UPDATE_CONTEXT",
  permissionDeny: "HOOK_PRE_PERMISSION_DENY_CONTEXT",
  post: "HOOK_POST_SUCCESS_CONTEXT",
  preDeny: "HOOK_PRE_DENY_CONTEXT",
  preRead: "HOOK_PRE_READ_CONTEXT",
  preWrite: "HOOK_PRE_MODIFY_CONTEXT",
  prompt: "HOOK_PROMPT_CONTEXT",
  promptBlock: "HOOK_PROMPT_BLOCK_CONTEXT",
  session: "HOOK_SESSION_CONTEXT",
  stop: (index: number) => `HOOK_STOP_CONTEXT_${index}`,
} as const;

export const HOOKS_REASON = {
  asyncIgnored: "HOOK_ASYNC_DECISION_MUST_BE_IGNORED",
  permissionDeny: "HOOK_PERMISSION_DENY_REASON",
  preDeny: "HOOK_PRE_DENY_REASON",
  promptBlock: "hooks_prompt_block",
} as const;

export const HOOKS_ERROR_DETAIL = {
  promptBlock:
    "python3: can't open file '/Users/dev/test/z-m/a.py': [Errno 2] No such file or directory",
} as const;

export const HOOKS_TOOL_CALL_IDS = {
  earlyInvalid: "toolu_e2e_hooks_early_invalid",
  earlyPermissionDeny: "toolu_e2e_hooks_early_permission_deny",
  earlyPreDeny: "toolu_e2e_hooks_early_pre_deny",
  fullRead: "toolu_e2e_hooks_full_read_missing",
  fullWrite: "toolu_e2e_hooks_full_write",
} as const;

export const HOOKS_RELATIVE_PATHS = {
  earlyInvalid: "hooks-full-e2e/invalid-update.txt",
  earlyInvalidTarget: "hooks-full-e2e/invalid-target.txt",
  earlyPermissionDeny: "hooks-full-e2e/permission-deny.txt",
  earlyPreDeny: "hooks-full-e2e/pre-deny.txt",
  fullFinal: "hooks-full-e2e/final.txt",
  fullMissing: "hooks-full-e2e/missing.txt",
  fullOriginal: "hooks-full-e2e/original.txt",
  fullPreModified: "hooks-full-e2e/pre-modified.txt",
} as const;

const HOOKS_CASE_ROOT = join(DEFAULT_WORKSPACE, "hooks-full-e2e");

const WORKSPACE_ZCODE_DIR = join(DEFAULT_WORKSPACE, ".zcode");
const USER_CONFIG_DIR = join(dirname(DEFAULT_WORKSPACE), ".zcode", "cli");
const CONFIG_PATH = join(USER_CONFIG_DIR, "config.json");
const RECORDER_PATH = join(WORKSPACE_ZCODE_DIR, "hooks-full-e2e-recorder.mjs");
const TRACE_PATH = join(WORKSPACE_ZCODE_DIR, "hooks-full-e2e-trace.jsonl");

let originalConfig: string | null = null;

export interface HookTraceRecord extends Record<string, unknown> {
  executor?: string;
  hook_event_name?: string;
  phase?: string;
  prompt?: string;
  session_id?: string;
  tool_name?: string;
}

export async function installHooksLifecycleFixture(): Promise<void> {
  await mkdir(WORKSPACE_ZCODE_DIR, { recursive: true });
  await mkdir(USER_CONFIG_DIR, { recursive: true });
  await rm(HOOKS_CASE_ROOT, { recursive: true, force: true });
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
  await writeFile(RECORDER_PATH, RECORDER_SOURCE, "utf8");

  const processHook = {
    type: "process",
    command: process.execPath,
    args: [RECORDER_PATH, TRACE_PATH, "process"],
    timeoutMs: 10000,
  } as const;
  const syncCommandHook = {
    type: "command",
    // Bug 根因：project hooks 属于不可信可执行配置，CLI 安全策略会主动忽略；
    // fixture 改写 user config 后，command 不能再依赖 project 相对路径，使用
    // case-local recorder 的绝对路径，仍只在隔离 E2E HOME 内执行。
    command: `"${process.execPath}" "${RECORDER_PATH}" "${TRACE_PATH}" command-sync`,
    timeoutMs: 10000,
  } as const;
  const asyncCommandHook = {
    type: "command",
    command: `"${process.execPath}" "${RECORDER_PATH}" "${TRACE_PATH}" command-async`,
    async: true,
    timeoutMs: 10000,
  } as const;

  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        ...existing,
        hooks: {
          enabled: true,
          timeoutMs: 10000,
          maxOutputBytes: 32768,
          events: {
            SessionStart: [
              { matcher: "startup", hooks: [processHook, syncCommandHook] },
            ],
            UserPromptSubmit: [
              {
                matcher: "matcher-must-not-filter-prompt",
                // Bug 根因：prompt-block 场景先执行同步 process deny 后，runner 会按
                // short-circuit 语义跳过后续 handler，旧顺序因此根本没启动 async hook。
                // async 放前面才能稳定验证“已启动的异步输出不参与当前决策”。
                hooks: [asyncCommandHook, processHook],
              },
            ],
            PreToolUse: [
              { matcher: "Write|Read", hooks: [processHook, syncCommandHook] },
            ],
            PermissionRequest: [
              { matcher: "Write", hooks: [processHook, syncCommandHook] },
            ],
            PostToolUse: [{ matcher: "Write", hooks: [processHook, syncCommandHook] }],
            PostToolUseFailure: [
              { matcher: "Read", hooks: [processHook, syncCommandHook] },
            ],
            Stop: [
              {
                matcher: "matcher-must-not-filter-response",
                hooks: [processHook],
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

export async function restoreHooksLifecycleFixture(): Promise<void> {
  if (originalConfig === null) {
    await rm(CONFIG_PATH, { force: true });
  } else {
    await writeFile(CONFIG_PATH, originalConfig, "utf8");
  }
  await rm(RECORDER_PATH, { force: true });
  await rm(TRACE_PATH, { force: true });
  await rm(HOOKS_CASE_ROOT, { recursive: true, force: true });
}

export async function waitForHookScenarioTrace(
  marker: string,
  predicate: (records: HookTraceRecord[]) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<HookTraceRecord[]> {
  let scenarioRecords: HookTraceRecord[] = [];
  await browser.waitUntil(
    async () => {
      const records = await readHookTraceRecords();
      const promptRecord = records.find(
        (record) =>
          record.executor === "process" &&
          record.phase === "completed" &&
          record.hook_event_name === "UserPromptSubmit" &&
          typeof record.prompt === "string" &&
          record.prompt.includes(marker),
      );
      if (!promptRecord?.session_id) return false;
      scenarioRecords = records.filter(
        (record) => record.session_id === promptRecord.session_id,
      );
      return predicate(scenarioRecords);
    },
    { timeout, timeoutMsg },
  );
  return scenarioRecords;
}

export async function readHookTraceRecords(): Promise<HookTraceRecord[]> {
  try {
    return (await readFile(TRACE_PATH, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookTraceRecord);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export function processHookRecords(
  records: HookTraceRecord[],
): HookTraceRecord[] {
  return records.filter(
    (record) => record.executor === "process" && record.phase === "completed",
  );
}

export function findHookEvent(
  records: HookTraceRecord[],
  event: string,
  toolName?: string,
): HookTraceRecord {
  const record = records.find(
    (item) =>
      item.hook_event_name === event &&
      (toolName === undefined || item.tool_name === toolName),
  );
  if (!record)
    throw new Error(
      `Missing ${event}${toolName ? ` hook for ${toolName}` : ""}`,
    );
  return record;
}

export function hasHookRecord(
  records: HookTraceRecord[],
  input: Partial<HookTraceRecord>,
): boolean {
  return records.some((record) =>
    Object.entries(input).every(([key, value]) => record[key] === value),
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

const RECORDER_SOURCE = String.raw`import { appendFileSync, existsSync, readFileSync } from "node:fs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const tracePath = process.argv[2];
const executor = process.argv[3] ?? "unknown";
const transcriptReadable = existsSync(input.transcript_path);
const transcriptText = transcriptReadable ? readFileSync(input.transcript_path, "utf8") : "";

function appendTrace(phase) {
  appendFileSync(
    tracePath,
    JSON.stringify({
      ...input,
      executor,
      phase,
      transcript_readable: transcriptReadable,
      transcript_text: transcriptText,
    }) + "\n",
    "utf8",
  );
}

if (
  executor === "process" &&
  input.hook_event_name === "UserPromptSubmit" &&
  input.prompt.includes("E2E_HOOKS_PROMPT_ERROR")
) {
  appendTrace("started");
  process.stderr.write("E2E simulated UserPromptSubmit hook failure\\n");
  process.exit(1);
}

if (executor === "command-async") {
  appendTrace("started");
  await new Promise((resolve) => setTimeout(resolve, 250));
  appendTrace("completed");
  process.stdout.write(JSON.stringify({
    continue: false,
    reason: "HOOK_ASYNC_DECISION_MUST_BE_IGNORED",
    additionalContext: "HOOK_ASYNC_CONTEXT_MUST_BE_IGNORED",
  }));
} else {
  appendTrace("completed");
  process.stdout.write(JSON.stringify(outputFor(input, executor)));
}

function outputFor(value, currentExecutor) {
  if (currentExecutor !== "process") return {};
  switch (value.hook_event_name) {
    case "SessionStart":
      return eventContext("SessionStart", "HOOK_SESSION_CONTEXT");
    case "UserPromptSubmit":
      if (value.prompt.includes("E2E_HOOKS_PROMPT_BLOCK")) {
        process.stderr.write(
          "python3: can't open file '/Users/dev/test/z-m/a.py': [Errno 2] No such file or directory\n",
        );
        return {
          continue: false,
          reason: "hooks_prompt_block",
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "HOOK_PROMPT_BLOCK_CONTEXT",
          },
        };
      }
      return eventContext("UserPromptSubmit", "HOOK_PROMPT_CONTEXT");
    case "PreToolUse":
      return preToolOutput(value);
    case "PermissionRequest":
      return permissionOutput(value);
    case "PostToolUse":
      return eventContext("PostToolUse", "HOOK_POST_SUCCESS_CONTEXT");
    case "PostToolUseFailure":
      return eventContext("PostToolUseFailure", "HOOK_POST_FAILURE_CONTEXT");
    case "Stop":
      return stopOutput(value);
    default:
      return {};
  }
}

function eventContext(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function preToolOutput(value) {
  const path = value.tool_input?.file_path;
  if (path === "hooks-full-e2e/original.txt") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "E2E full-chain approval",
        additionalContext: "HOOK_PRE_MODIFY_CONTEXT",
        updatedInput: {
          ...value.tool_input,
          file_path: "hooks-full-e2e/pre-modified.txt",
          content: "pretool modified content\n",
        },
      },
    };
  }
  if (path === "hooks-full-e2e/pre-deny.txt") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "HOOK_PRE_DENY_REASON",
        additionalContext: "HOOK_PRE_DENY_CONTEXT",
      },
    };
  }
  if (path === "hooks-full-e2e/invalid-update.txt") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "HOOK_PRE_INVALID_UPDATE_CONTEXT",
        updatedInput: { file_path: "hooks-full-e2e/invalid-target.txt" },
      },
    };
  }
  if (path === "hooks-full-e2e/permission-deny.txt") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "E2E permission deny path",
        additionalContext: "HOOK_PRE_PERMISSION_DENY_CONTEXT",
      },
    };
  }
  return eventContext("PreToolUse", "HOOK_PRE_READ_CONTEXT");
}

function permissionOutput(value) {
  const path = value.tool_input?.file_path;
  if (path === "hooks-full-e2e/permission-deny.txt") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "HOOK_PERMISSION_DENY_REASON" },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          ...value.tool_input,
          file_path: "hooks-full-e2e/final.txt",
          content: "permission modified content\n",
        },
      },
    },
  };
}

function stopOutput(value) {
  const match = /E2E_HOOKS_STOP_CAP_STEP_(\d+)/u.exec(value.last_assistant_message ?? "");
  if (!match) return {};
  return { decision: "block", reason: "HOOK_STOP_CONTEXT_" + (Number(match[1]) + 1) };
}
`;
