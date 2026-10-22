import { BACKGROUND_BASH_OUTPUT_MAX_BYTES, type BackgroundBashOutputResult } from "@zcode/shared";
import { readBashOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterRun } from "./node-execution-adapter-run.js";
import {
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isBashMergedOutputRequest,
} from "./execution-utils.js";
import type {
  BashBackgroundLifecycleMode,
  BashBackgroundLifecycleResult,
  InternalExecutionRunOptions,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export class NodeExecutionAdapterLifecycle extends NodeExecutionAdapterRun {
  async start(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<BackgroundExecutionStartResult> {
    if (this.closePromise) {
      throw new Error("Execution adapter is shutting down");
    }

    const preparation = this.usesBashTempOutput(request)
      ? await this.prepareBashOutput(request, options)
      : undefined;

    const taskId = `exec_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const startedAt = new Date();
    const outputPaths =
      preparation && "result" in preparation ? {} : this.outputPathsForRequest(request);
    const runRequest =
      request.captureCwdAfterSuccess === true
        ? { ...request, captureCwdAfterSuccess: undefined }
        : request;
    if (runRequest !== request) {
      this.outputPathsByRequest.set(runRequest, outputPaths);
    }
    if (!isBashMergedOutputRequest(runRequest)) await this.ensureBackgroundOutputFiles(outputPaths);
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });
    this.backgroundTasks.set(taskId, record);

    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    if (preparation && "result" in preparation) this.emitResult(options, preparation.result);
    const running =
      preparation && "result" in preparation
        ? Promise.resolve(preparation.result)
        : this.run(runRequest, {
            ...options,
            preparedBashOutput:
              preparation && "prepared" in preparation ? preparation.prepared : undefined,
            signal: controller.signal,
            onOutputEncodingResolved: (encoding) => {
              record.legacyOutputEncoding = encoding;
            },
            shouldRetainExecutionAfterRootExit: () => true,
            ...(isBashMergedOutputRequest(runRequest)
              ? { bashLifecycle: { isBackgrounded: () => true } }
              : {}),
            onEvent: (event) => {
              this.updateBackgroundTaskRecordFromEvent(record, event);
              return options.onEvent?.(event);
            },
          } as InternalExecutionRunOptions);
    void running.then(
      (result) => {
        this.finalizeBackgroundTaskRecord(record, result);
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
      (error) => {
        const failure = this.toFailure("unknown", error);
        this.finalizeBackgroundTaskRecord(
          record,
          this.createStoppedResult(startedAt, "spawn_error", failure.message),
        );
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
    );

    return {
      taskId,
      status: "running",
      startedAt,
      pid: record.pid,
      ...outputPaths,
    };
  }

  async runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options: ExecutionRunOptions = {},
  ): Promise<BashBackgroundLifecycleResult> {
    const useBashFile = isBashMergedOutputRequest(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (lifecycle.mode === "auto_on_timeout" && timeoutMs <= 0) {
      return {
        kind: "foreground",
        result: await this.run(request, options),
      };
    }

    const taskId = `exec_${crypto.randomUUID()}`;
    const startedAt = new Date();
    const controller = new AbortController();
    const originalPersistOutput = request.outputLimit?.persistOutput ?? "none";
    const originalMaxArtifactBytes = useBashFile
      ? undefined
      : (request.outputLimit?.maxArtifactBytes ?? this.persistedOutputLimit(request));
    const runRequest: ExecutionRequest = {
      ...request,
      timeoutMs: 0,
      outputLimit: {
        ...request.outputLimit,
        killProcessOnPersistedLimit: false,
        maxPersistedBytes: BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
        persistOutput: "always",
      },
    };
    const preparation = this.usesBashTempOutput(runRequest)
      ? await this.prepareBashOutput(runRequest, options)
      : undefined;
    if (preparation && "result" in preparation) {
      this.emitResult(options, preparation.result);
      return { kind: "foreground", result: preparation.result };
    }
    const outputPaths = this.outputPathsForRequest(runRequest);
    if (!isBashMergedOutputRequest(runRequest)) {
      await this.ensureBackgroundOutputFiles(outputPaths);
    }
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });

    type LifecycleState = "preparing" | "foreground" | "backgrounded" | "settling" | "terminal";
    let state: LifecycleState = "preparing";
    const bashLifecycle: InternalExecutionRunOptions["bashLifecycle"] = useBashFile
      ? {
          isBackgrounded: () => state === "backgrounded",
          onExit: () => {
            // root 已退出后只是异步读取结果，不能被前台 deadline 再转为后台任务。
            if (state === "preparing" || state === "foreground") {
              state = "settling";
              clearForegroundDeadline();
              removeExternalAbort();
            }
          },
        }
      : undefined;
    let persistedLimitReached = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveOutcome: (result: BashBackgroundLifecycleResult) => void = () => undefined;
    const outcome = new Promise<BashBackgroundLifecycleResult>((resolve) => {
      resolveOutcome = resolve;
    });

    const externalAbort = () => {
      if (state === "backgrounded" || state === "terminal") return;
      controller.abort();
    };
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    const removeExternalAbort = () => {
      if (!record.externalAbort) return;
      options.signal?.removeEventListener("abort", record.externalAbort);
      record.externalAbort = undefined;
    };

    const clearForegroundDeadline = () => {
      if (!timeoutTimer) return;
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    const commitBackground = () => {
      if (state !== "foreground" || controller.signal.aborted) return false;

      // 旧 explicit background 复用了通用 start()，foreground timeout 与
      // parent turn abort 会继续挂在子进程上。这里先原子提交状态，再同步清理 deadline、
      // 脱离 parent abort 并登记 task，避免 abort/completion 在提交缝隙里误杀后台进程。
      state = "backgrounded";
      bashLifecycle?.onBackgrounded?.();
      clearForegroundDeadline();
      removeExternalAbort();
      this.backgroundTasks.set(taskId, record);
      if (persistedLimitReached) {
        controller.abort("output_limit");
      }
      resolveOutcome({
        kind: "backgrounded",
        task: {
          taskId,
          status: "running",
          startedAt,
          pid: record.pid,
          ...outputPaths,
        },
      });
      return true;
    };

    const armForegroundDeadline = () => {
      if (lifecycle.mode !== "auto_on_timeout" || timeoutTimer || state !== "foreground") {
        return;
      }
      timeoutTimer = setTimeout(commitBackground, timeoutMs);
    };

    const backgroundRunOptions: InternalExecutionRunOptions = {
      ...options,
      preparedBashOutput: preparation?.prepared,
      signal: controller.signal,
      onOutputEncodingResolved: (encoding) => {
        record.legacyOutputEncoding = encoding;
      },
      bashLifecycle,
      onPersistedLimit: () => {
        if (!controller.signal.aborted) {
          persistedLimitReached = true;
        }
      },
      onEvent: (event) => {
        this.updateBackgroundTaskRecordFromEvent(record, event);
        if (
          event.type === "started" &&
          event.pid !== undefined &&
          state === "preparing" &&
          !controller.signal.aborted
        ) {
          state = "foreground";
          if (lifecycle.mode === "explicit") {
            commitBackground();
          } else {
            armForegroundDeadline();
          }
        }
        if (state === "backgrounded") return;
        return options.onEvent?.(event);
      },
      // 通用 lifecycle 仍使用独立 collector 和共享硬预算；Bash 由文件 watchdog 处理。
      sharePersistedOutputLimitAcrossStreams: true,
      shouldStopOnPersistedLimit: () => state === "backgrounded",
      shouldRetainExecutionAfterRootExit: () => state === "backgrounded",
    };

    const settleExecution = async (unprocessedResult: ExecutionResult) => {
      clearForegroundDeadline();
      if (state === "backgrounded") {
        this.finalizeBackgroundTaskRecord(
          record,
          this.normalizeBashBackgroundOutputLimitResult(unprocessedResult, persistedLimitReached),
        );
        return;
      }
      if (state === "terminal") return;

      state = "terminal";
      removeExternalAbort();
      const result = await this.normalizeBashBackgroundLifecycleForegroundResult(
        unprocessedResult,
        outputPaths,
        originalMaxArtifactBytes,
        originalPersistOutput,
      );
      // 前台完成仍复用 BackgroundTaskRecord；只结算 outcome 会让
      // record.completion 永久保持 pending，并被异步资源检测识别为泄漏。
      this.finalizeBackgroundTaskRecord(record, result);
      resolveOutcome({
        kind: "foreground",
        result,
      });
    };

    void (async () => {
      try {
        await settleExecution(await this.run(runRequest, backgroundRunOptions));
      } catch (error) {
        const failure = this.toFailure("unknown", error);
        await settleExecution(this.createStoppedResult(startedAt, "spawn_error", failure.message));
      }
    })();

    return await outcome;
  }

  async readBackgroundBashOutput(
    workId: string,
    sessionId: string,
  ): Promise<BackgroundBashOutputResult> {
    const record = this.backgroundTasks.get(workId);
    if (!record || record.sessionId !== sessionId || !record.isBash || !record.outputPath)
      return { kind: "unavailable", workId };
    // 先冻结状态，再读文件；若读取期间退出，下次查询才能返回终态及其最终尾窗。
    const snapshot = this.snapshot(record);
    try {
      const output = await readBashOutput(
        record.outputPath,
        BACKGROUND_BASH_OUTPUT_MAX_BYTES,
        true,
        record.legacyOutputEncoding,
      );
      return {
        kind: "output",
        workId,
        // Stop 先标记 cancelled，结算稍后才完成；不能让详情提前停止最终尾读。
        status: snapshot.result ? snapshot.status : "running",
        output: output.text,
        truncated: output.truncated,
        outputPath: record.outputPath,
      };
    } catch (error) {
      return {
        kind: "read_failed",
        workId,
        code: error instanceof Error && "code" in error ? String(error.code) : undefined,
      };
    }
  }

  async getBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
  }

  async waitForBackgroundTask(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status !== "running") return this.snapshot(record);
    if (options.signal?.aborted) return this.snapshot(record);

    if (!options.signal) return await record.completion;

    return await new Promise<BackgroundExecutionSnapshot>((resolve) => {
      const abort = () => resolve(this.snapshot(record));
      options.signal?.addEventListener("abort", abort, { once: true });
      record.completion.then((snapshot) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(snapshot);
      });
    });
  }

  async cancelBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status === "running") {
      record.status = "cancelled";
      record.controller.abort();
    }
    return this.snapshot(record);
  }
}
