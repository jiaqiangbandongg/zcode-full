import {
  type BashInput,
  type BashOutput,
  type ToolCommandStatus,
  type ExecutionResult,
  type ToolExecutionTelemetry,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { appendBashCwdStderrSuffix } from "./bash-cwd-policy.js";
import { getGhRateLimitHint } from "./bash-gh-rate-limit.js";
import { prepareBashImageOutput } from "./bash-image-output.js";
import {
  interpretBashReturnCode,
  isBashProviderErrorStatus,
  isSilentBashCommand,
  stripClaudeCodeHintLines,
} from "./bash-semantics.js";
import {
  attachToolExecutionTelemetry,
  classifyCommand,
  classifySafeCommandIdentity,
  commandHash,
  compactToolExecutionTelemetry,
  roundNonNegativeMs,
} from "./tool-perf.js";

export interface BashProgressTiming {
  firstOutputMs?: number;
}

export async function toBashOutput(
  result: ExecutionResult,
  input: BashInput,
  context: ToolExecutionContext,
  options: { progressTiming?: BashProgressTiming; stderrSuffix?: string } = {},
): Promise<BashOutput> {
  const stdoutPersistedOutputPath = result.stdout.artifactPath;
  const stderrPersistedOutputPath = result.stderr.artifactPath;
  const persistedOutputPath = stdoutPersistedOutputPath ?? stderrPersistedOutputPath;
  const stdoutPersistedOutputSize = result.stdout.artifactBytes;
  const stderrPersistedOutputSize = result.stderr.artifactBytes;
  // artifactBytes 是 64MiB cap 后的实际文件大小，不是模型可见文案中的
  // 原始观测大小。Bash persisted-output 必须使用截断前的 stream bytes。
  const persistedOutputSize = persistedOutputPath
    ? (stdoutPersistedOutputPath ? result.stdout.bytes : 0) +
      (stderrPersistedOutputPath ? result.stderr.bytes : 0)
    : undefined;
  const stderr = appendBashCwdStderrSuffix(
    result.stderr.text || result.error?.message || "",
    options.stderrSuffix,
  );
  const returnCodeInterpretation = interpretBashReturnCode(input.command, result);
  const providerError = isBashProviderErrorStatus({
    exitCode: result.exitCode,
    returnCodeInterpretation,
    status: result.status,
  });
  const providerStdout = providerError
    ? result.stdout.text
    : stripClaudeCodeHintLines(result.stdout.text);
  const imageOutput = providerError
    ? undefined
    : await prepareBashImageOutput(
        {
          artifactPath: stdoutPersistedOutputPath,
          artifactSize: stdoutPersistedOutputSize,
          inline: providerStdout,
        },
        context,
      );
  const stdout = imageOutput?.stdout ?? providerStdout;

  const ghRateLimitHint = providerError
    ? undefined
    : getGhRateLimitHint(input.command, result.stdout.text);
  return attachToolExecutionTelemetry(
    {
      stdout,
      stderr,
      interrupted: result.timedOut || result.cancelled,
      isImage: imageOutput !== undefined,
      noOutputExpected: isSilentBashCommand(input.command),
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
      stdoutBytes: result.stdout.bytes,
      stderrBytes: result.stderr.bytes,
      rawOutputPath: persistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      returnCodeInterpretation,
      persistedOutputPath,
      stdoutPersistedOutputPath,
      stderrPersistedOutputPath,
      persistedOutputSize,
      stdoutPersistedOutputSize,
      stderrPersistedOutputSize,
      ...(ghRateLimitHint ? { ghRateLimitHint } : {}),
    },
    createBashPerformanceTelemetry(input, result, options.progressTiming),
  );
}

function createBashPerformanceTelemetry(
  input: BashInput,
  result: ExecutionResult,
  progressTiming: BashProgressTiming | undefined,
): ToolExecutionTelemetry | undefined {
  const outputBytes = result.stdout.bytes + result.stderr.bytes;
  const firstOutputMs = progressTiming?.firstOutputMs;
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        runMs: roundNonNegativeMs(result.durationMs),
        firstOutputMs,
        noOutputMs: firstOutputMs ?? roundNonNegativeMs(result.durationMs),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputBytes,
        category: classifyCommand(input.command),
        ...classifySafeCommandIdentity(input.command),
        status: resolveBashCommandStatus(result),
        hash: commandHash(input.command),
      },
    },
  });
}

export function createBashBackgroundPerformanceTelemetry(
  input: BashInput,
): ToolExecutionTelemetry | undefined {
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        category: classifyCommand(input.command),
        ...classifySafeCommandIdentity(input.command),
        status: "backgrounded",
        hash: commandHash(input.command),
      },
    },
  });
}

export function createEmptyBashPerformanceTelemetry(
  input: BashInput,
): ToolExecutionTelemetry | undefined {
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        category: "empty",
        count: 0,
        name: "empty",
        status: "completed",
        hash: commandHash(input.command),
      },
    },
  });
}

function resolveBashCommandStatus(
  result: ExecutionResult,
): ToolCommandStatus {
  if (result.timedOut) return "timed_out";
  if (result.cancelled) return "cancelled";
  if (result.status === "completed" && result.exitCode !== undefined && result.exitCode !== 0) {
    return "failed";
  }
  return result.status;
}
