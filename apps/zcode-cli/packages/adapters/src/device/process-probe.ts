import { readdir, readFile } from "node:fs/promises";
import { readDarwinProcessGroup, readDarwinProcessTable } from "./process-probe-darwin.js";
import {
  sampleLinuxProcessGroup,
  sampleLinuxProcessTrees,
  type LinuxProcReaders,
} from "./process-probe-linux.js";
import {
  defaultProbeExecFile,
  groupProcessTrees,
  isSamplablePid,
  toSample,
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";
import { readWindowsProcessMemory } from "./process-probe-windows.js";

export {
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeCommandResult,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/** 进程树采样的实际口径：Windows 的 tasklist 没有 ppid，只能拿到直连进程。 */
export type ProcessTreeScope = "direct_process" | "process_tree";

/**
 * 通用进程探针：给一批 pid 或一个进程组 id，回每个进程的 RSS 与累计 CPU 时间。
 * MCP 5 分钟采样、Bash 慢命令采样共用本模块。
 *
 * 性能红线约束本模块：
 * - 外部进程白名单只有 macOS 的 `ps` 与 Windows 的 `tasklist`，每次采样最多一次调用；
 * - Linux 一律读 `/proc`，不启动任何进程；
 * - 每次采样 1 秒超时，超时或失败一律视为「本次无样本」，不重试、不排队；
 * - 连续 3 次失败后本实例停用，直到调用方在下一个上报窗口显式 `reset()`。
 *
 * 失败预算属于探针实例：一个 CLI 进程里每个采样场景（MCP、Bash 命令）各持有一个长生命周期实例，
 * 场景之间互不影响，窗口切换时由调用方 `reset()`。
 */
export interface ProcessProbe {
  /**
   * 按根 pid 采整棵进程树（含根自身），返回 root pid → 树内各进程样本。
   * 采样时已不存在的根不会出现在结果里；返回 `undefined` 表示本次无样本。
   */
  sampleProcessTrees(
    rootPids: readonly number[],
  ): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]> | undefined>;
  /** 按进程组 id 采样；Windows 无进程组语义，恒为无样本且不启动进程。 */
  sampleProcessGroup(processGroupId: number): Promise<readonly ProcessProbeSample[] | undefined>;
  /** 上报窗口切换时清零连续失败计数，让被停用的探针在新窗口重新可用。 */
  reset(): void;
  /** 本平台 `sampleProcessTrees` 的口径，调用方据此标注样本范围，不用自己判平台。 */
  readonly treeScope: ProcessTreeScope;
}

export interface CreateProcessProbeOptions {
  execFile?: ProcessProbeExecFile;
  /** 列出 `/proc` 下的条目，仅 Linux 使用 */
  listProcDirectory?: () => Promise<readonly string[]>;
  /** 每次采样失败（含超时）的原因；调用方接到自己的 debug 日志，探针本身不做 I/O */
  onSampleFailed?: (reason: string) => void;
  platform?: NodeJS.Platform;
  /** 读取 `/proc/<pid>/stat` 与 `/proc/<pid>/status`，仅 Linux 使用 */
  readProcFile?: (path: string) => Promise<string>;
}

export const PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES = 3;

const PROBE_TIMED_OUT = Symbol("process-probe-timed-out");

export function createProcessProbe(options: CreateProcessProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultProbeExecFile;
  const listProcDirectory = options.listProcDirectory ?? (() => readdir("/proc"));
  const readProcFile = options.readProcFile ?? ((path: string) => readFile(path, "utf8"));
  let consecutiveFailures = 0;

  const reportFailure = (reason: string): undefined => {
    consecutiveFailures += 1;
    try {
      options.onSampleFailed?.(reason);
    } catch {
      // 观测回调抛错不能反过来影响采样与业务。
    }
    return undefined;
  };

  /** 一次采样的统一收口：超时、异常、命令失败都只表现为「无样本」，并累计失败预算。 */
  const sampleWithinBudget = async <T>(
    collect: (readers: LinuxProcReaders) => Promise<T>,
  ): Promise<T | undefined> => {
    if (consecutiveFailures >= PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES) return undefined;
    const deadline = Date.now() + PROCESS_PROBE_SAMPLE_TIMEOUT_MS;
    let outcome: T | typeof PROBE_TIMED_OUT;
    try {
      outcome = await raceProbeTimeout(
        collect({
          isExpired: () => Date.now() >= deadline,
          listProcDirectory,
          readProcFile,
        }),
      );
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
    if (outcome === PROBE_TIMED_OUT) {
      return reportFailure(`采样超过 ${PROCESS_PROBE_SAMPLE_TIMEOUT_MS} 毫秒`);
    }
    consecutiveFailures = 0;
    return outcome;
  };

  return {
    treeScope: platform === "win32" ? "direct_process" : "process_tree",
    async sampleProcessTrees(rootPids) {
      const roots = [...new Set(rootPids.filter(isSamplablePid))];
      if (roots.length === 0) return new Map();
      if (platform === "win32") {
        const samples = await sampleWithinBudget(() => readWindowsProcessMemory(execFile, roots));
        if (!samples) return undefined;
        // tasklist 没有 ppid，Windows 的「进程树」只能退化为根进程自身，见 treeScope。
        return new Map(samples.map((sample) => [sample.pid, [sample]]));
      }
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessTrees(readers, roots)
          : groupProcessTrees(await readDarwinProcessTable(execFile), roots),
      );
    },
    async sampleProcessGroup(processGroupId) {
      if (!isSamplablePid(processGroupId)) return undefined;
      // Windows 没有进程组语义，也没有零成本的进程树数据源，直接放弃本次采样。
      if (platform === "win32") return undefined;
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessGroup(readers, processGroupId)
          : (await readDarwinProcessGroup(execFile, processGroupId)).map(toSample),
      );
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
}

/**
 * 1 秒硬超时：`ps` / `tasklist` 由 execFile 的 timeout 真杀进程；
 * `/proc` 读取无法取消，由 readers.isExpired 在批次边界中止，这里只负责判负返回。
 */
async function raceProbeTimeout<T>(work: Promise<T>): Promise<T | typeof PROBE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof PROBE_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROCESS_PROBE_SAMPLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
