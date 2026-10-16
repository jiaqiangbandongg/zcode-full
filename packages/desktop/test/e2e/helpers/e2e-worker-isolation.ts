import { resolve } from "node:path";

const DEFAULT_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_E2E_WEBDRIVER_REQUEST_RETRY_COUNT = 0;
const MAX_E2E_WEBDRIVER_REQUEST_RETRY_COUNT = 3;
const BG26_SPEC_MARKER = "conversation-session-background-subagent-rate-limit.test.ts";
const MODEL_SWITCH_RESTORE_REPRO_SPEC_MARKER =
  "conversation-session-model-switch-restore-repro.test.ts";
const BG25_SPEC_MARKER = "conversation-session-subagent-respond-to-coordinator.test.ts";
const I55_SPEC_MARKER = "conversation-session-thought-level-session-isolation.test.ts";
const REPLAY_MODEL_STREAM_IDLE_TIMEOUT_MS = 10_000;
const SSE_STALL_DIAGNOSTIC_SPEC_MARKER = "conversation-session-sse-stall-diagnostic.test.ts";
const SSE_STALL_DIAGNOSTIC_IDLE_TIMEOUT_MS = 1_000;
const REPLAY_PROXY_ISOLATED_SPEC_MARKERS = [BG25_SPEC_MARKER, I55_SPEC_MARKER] as const;
const MODEL_RETRY_DISABLED_SPEC_MARKERS = [
  BG26_SPEC_MARKER,
  MODEL_SWITCH_RESTORE_REPRO_SPEC_MARKER,
  // N05 只验证 TurnError 的 queue 保留/显式恢复；retry 次数是 N03/N04 的独立合同，
  // 必须关闭默认 retry，避免 fixture 消耗一次 500 后悬挂在未匹配的重试请求上。
  "conversation-session-turn-error-queue-preserved.test.ts",
  // 冷恢复历史活动回归复用同一 500 + accepted queue 窗口，也不能让无关重试
  // 把 turn 保持在 streaming，必须沿用 N05 的零重试隔离。
  "conversation-session-turn-error-history-activity.test.ts",
] as const;
const MODEL_RETRY_MAX_RETRIES_ENV = "ZCODE_MODEL_RETRY_MAX_RETRIES";
const HTTP_PROXY_ENV = "ZCODE_HTTP_PROXY";
const NO_PROXY_ENV = "ZCODE_NO_PROXY";

interface E2EWorkerNetworkEnvSnapshot {
  httpProxy: string | undefined;
  noProxy: string | undefined;
}

export function applyE2EWorkerModelRetryEnv(
  env: Record<string, string | undefined>,
  specs: string[],
  configuredMaxRetries: string | undefined,
): void {
  if (MODEL_RETRY_DISABLED_SPEC_MARKERS.some((marker) => workerSpecsContain(specs, marker))) {
    // Bug 根因：BG26 和模型切换恢复回归都只验证 429 原始错误的
    // terminal/UI/snapshot 投影，却继承了产品默认 10 次网络重试，导致 projection case
    // 同时承担无关的退避等待语义。仅这些 worker 禁用 retry；其它 worker 恢复启动前配置。
    env[MODEL_RETRY_MAX_RETRIES_ENV] = "0";
    return;
  }

  if (configuredMaxRetries === undefined) {
    delete env[MODEL_RETRY_MAX_RETRIES_ENV];
  } else {
    env[MODEL_RETRY_MAX_RETRIES_ENV] = configuredMaxRetries;
  }
}

export function applyE2EWorkerReplayProxyEnv(
  env: Record<string, string | undefined>,
  specs: string[],
  replayBaseUrl: string,
  configuredEnv: E2EWorkerNetworkEnvSnapshot,
): void {
  if (REPLAY_PROXY_ISOLATED_SPEC_MARKERS.some((marker) => workerSpecsContain(specs, marker))) {
    // Bug 根因：BG25 的 parent continuation 与 I55 的 title/main 并发请求都复现过
    // global fetch 已发布 network.started、但物理请求未到本地 replay server 的首包前停滞。
    // 仅这两个 worker 使用独立 ProxyAgent 通道；BG26 在该通道反而会卡住 notification，
    // 因此仍保持默认直连，不能把隔离策略扩散到其它 case。
    env[HTTP_PROXY_ENV] = replayBaseUrl;
    env[NO_PROXY_ENV] = "";
    return;
  }

  restoreEnvValue(env, HTTP_PROXY_ENV, configuredEnv.httpProxy);
  restoreEnvValue(env, NO_PROXY_ENV, configuredEnv.noProxy);
}

export function resolveE2EWorkerModelStreamIdleTimeoutMs(
  specs: string[],
): number | undefined {
  if (workerSpecsContain(specs, SSE_STALL_DIAGNOSTIC_SPEC_MARKER)) {
    // 诊断原因：该 case 必须让 socket 保持打开且不再下发 event，再由真实
    // model-stream idle watchdog 触发恢复；只缩短当前 worker，避免五个 cutoff
    // 各等待生产默认 600s，也不能把测试阈值写进产品配置。
    return SSE_STALL_DIAGNOSTIC_IDLE_TIMEOUT_MS;
  }
  if (!REPLAY_PROXY_ISOLATED_SPEC_MARKERS.some((marker) => workerSpecsContain(specs, marker))) {
    return undefined;
  }

  // Bug 根因：BG25 和 I55 的 capture 等待上限是 60s，而产品默认 SSE 首包空闲超时是
  // 600s；本地 replay 的某次 parent/child 并发请求偶发停在物理发送前时，case 会先失败，
  // runtime 尚未获得 abort/retry 机会。只缩短已复现 worker 的屏障，让悬挂 attempt
  // 有界释放后重试；不改变其它 E2E，更不会进入生产配置。
  return REPLAY_MODEL_STREAM_IDLE_TIMEOUT_MS;
}

export function resolveE2EWebDriverRequestLimits(overrides: {
  retryCount?: string;
  timeoutMs?: string;
}): { retryCount: number; timeoutMs: number } {
  return {
    retryCount: resolveBoundedInteger(
      overrides.retryCount,
      DEFAULT_E2E_WEBDRIVER_REQUEST_RETRY_COUNT,
      0,
      MAX_E2E_WEBDRIVER_REQUEST_RETRY_COUNT,
    ),
    timeoutMs: resolveBoundedInteger(
      overrides.timeoutMs,
      DEFAULT_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS,
      1,
      MAX_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS,
    ),
  };
}

function resolveBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function restoreEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete env[key];
  } else {
    env[key] = value;
  }
}

export function workerSpecsContain(specs: string[], marker: string): boolean {
  return specs.some((spec) => spec.includes(marker));
}

export function resolveE2EWorkerChromiumProfileDir(rootDir: string, cid: string): string {
  const safeCid = cid.replace(/[^a-zA-Z0-9._-]/gu, "-");
  return resolve(rootDir, safeCid || "worker");
}

export function replaceChromeUserDataDirArg(args: string[], profileDir: string): string[] {
  return [
    ...args.filter((arg) => !arg.startsWith("--user-data-dir=")),
    `--user-data-dir=${profileDir}`,
  ];
}
