import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildZCodeDataSizeArmsPayload,
  createZCodeDataSizeTelemetryScheduler,
  type ZCodeDataSizeTelemetryState,
} from "../src/main/desktopZCodeDataSizeTelemetry.js";
import {
  scanZCodeDataDirectory,
  type ZCodeDataSizeScanResult,
} from "../src/main/zcodeDataSizeScanner.js";
import {
  readZCodeDataSizeTelemetryState,
  writeZCodeDataSizeTelemetryState,
} from "../src/main/zcodeDataSizeTelemetryState.js";

const COMPLETE_RESULT: ZCodeDataSizeScanResult = {
  bytes: 42,
  directoriesScanned: 2,
  durationMs: 15,
  filesScanned: 3,
  scanErrorCount: 0,
  status: "complete",
};

const TEST_TIMING = {
  abortedRetryMs: 30 * 60 * 1000,
  activityPollMs: 1_000,
  dailyIntervalMs: 24 * 60 * 60 * 1000,
  dailyJitterMaxMs: 0,
  failureRetryMs: 6 * 60 * 60 * 1000,
  idlePollMs: 5 * 60 * 1000,
  idleWaitFallbackMs: 6 * 60 * 60 * 1000,
  startupJitterMaxMs: 0,
  startupMinDelayMs: 0,
};

describe("scanZCodeDataDirectory", () => {
  let rootPath = "";

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "zcode-data-size-"));
  });

  afterEach(async () => {
    if (rootPath) {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it("统计数据根下嵌套普通文件的逻辑字节数", async () => {
    await mkdir(join(rootPath, "cli", "log"), { recursive: true });
    await writeFile(join(rootPath, "root.txt"), "12345");
    await writeFile(join(rootPath, "cli", "log", "agent.log"), "1234567");

    const result = await scanZCodeDataDirectory({
      maxDurationMs: 30_000,
      maxFiles: 200_000,
      rootPath,
    });

    expect(result).toEqual({
      bytes: 12,
      directoriesScanned: 3,
      durationMs: expect.any(Number),
      filesScanned: 2,
      scanErrorCount: 0,
      status: "complete",
    });
  });

  it("达到文件数保护后返回可识别的下界而不是伪装成完整值", async () => {
    await writeFile(join(rootPath, "one.txt"), "111");
    await writeFile(join(rootPath, "two.txt"), "2222");

    const result = await scanZCodeDataDirectory({
      maxDurationMs: 30_000,
      maxFiles: 1,
      rootPath,
    });

    expect(result.status).toBe("partial");
    expect(result.partialReason).toBe("file_limit");
    expect(result.filesScanned).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("达到时间保护后返回 time_limit partial", async () => {
    await writeFile(join(rootPath, "one.txt"), "111");

    const result = await scanZCodeDataDirectory({
      maxDurationMs: 0,
      maxFiles: 200_000,
      rootPath,
    });

    expect(result).toMatchObject({
      bytes: 0,
      filesScanned: 0,
      partialReason: "time_limit",
      status: "partial",
    });
  });
});

describe("createZCodeDataSizeTelemetryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness(options?: {
    appBackground?: boolean;
    busy?: boolean;
    dailyJitterMaxMs?: number;
    deviceMid?: string;
    idleSeconds?: number;
    onScan?: () => void;
    onWriteState?: () => void;
    readState?: () => Promise<ZCodeDataSizeTelemetryState | null>;
    state?: ZCodeDataSizeTelemetryState | null;
    writeStateError?: Error;
  }) {
    let appBackground = options?.appBackground ?? true;
    let busy = options?.busy ?? false;
    let idleSeconds = options?.idleSeconds ?? 300;
    let state = options?.state ?? null;
    const report = vi.fn();
    const scan = vi.fn(async () => {
      options?.onScan?.();
      return COMPLETE_RESULT;
    });
    const readState = vi.fn(options?.readState ?? (async () => state));
    const writeState = vi.fn(async (next: ZCodeDataSizeTelemetryState) => {
      options?.onWriteState?.();
      if (options?.writeStateError) {
        throw options.writeStateError;
      }
      state = next;
    });
    const scheduler = createZCodeDataSizeTelemetryScheduler({
      deviceMid: options?.deviceMid ?? "device-1",
      getSystemIdleTimeSeconds: () => idleSeconds,
      isAppBackground: () => appBackground,
      isZCodeBusy: () => busy,
      logger: { info: vi.fn(), warn: vi.fn() },
      readState,
      report,
      scan,
      timing: {
        ...TEST_TIMING,
        dailyJitterMaxMs: options?.dailyJitterMaxMs ?? TEST_TIMING.dailyJitterMaxMs,
      },
      writeState,
    });

    return {
      readState,
      report,
      scan,
      scheduler,
      setAppBackground(value: boolean) {
        appBackground = value;
      },
      setBusy(value: boolean) {
        busy = value;
      },
      setIdleSeconds(value: number) {
        idleSeconds = value;
      },
      writeState,
    };
  }

  it("到期后只在系统空闲、App 后台且无运行任务时采集", async () => {
    const harness = createHarness({ appBackground: false, idleSeconds: 0 });
    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.scan).not.toHaveBeenCalled();

    harness.setAppBackground(true);
    harness.setIdleSeconds(300);
    await vi.advanceTimersByTimeAsync(TEST_TIMING.idlePollMs);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).toHaveBeenCalledWith(COMPLETE_RESULT);
    expect(harness.writeState).toHaveBeenCalledWith({
      lastReportedAt: Date.now(),
    });
    harness.scheduler.stop();
  });

  it("无法持久化限流 reservation 时不发送样本", async () => {
    const harness = createHarness({
      writeStateError: new Error("disk full"),
    });

    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it("读取限流状态失败时不采集，并在重试成功后按持久化状态调度", async () => {
    const startedAt = Date.now();
    let readAttempts = 0;
    const harness = createHarness({
      readState: async () => {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw new Error("EIO");
        }
        return { lastReportedAt: startedAt };
      },
    });

    await harness.scheduler.start();
    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(TEST_TIMING.failureRetryMs - 1);

    expect(harness.readState).toHaveBeenCalledOnce();
    expect(harness.scan).not.toHaveBeenCalled();
    expect(harness.report).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.readState).toHaveBeenCalledTimes(2);
    expect(harness.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TEST_TIMING.dailyIntervalMs - TEST_TIMING.failureRetryMs - 1);
    expect(harness.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).toHaveBeenCalledOnce();
    harness.scheduler.stop();
  });

  it("低干扰窗口等待满六小时后允许前台 fallback，但运行任务仍是硬阻塞", async () => {
    const harness = createHarness({ appBackground: false, busy: true, idleSeconds: 0 });
    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(TEST_TIMING.idleWaitFallbackMs);

    expect(harness.scan).not.toHaveBeenCalled();

    harness.setBusy(false);
    await vi.advanceTimersByTimeAsync(TEST_TIMING.idlePollMs);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).toHaveBeenCalledOnce();
    harness.scheduler.stop();
  });

  it("持久化成功时间保证重启后 24 小时内不重复采集", async () => {
    const startedAt = Date.now();
    const harness = createHarness({
      state: { lastReportedAt: startedAt },
    });
    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(TEST_TIMING.dailyIntervalMs - 1);

    expect(harness.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.scan).toHaveBeenCalledOnce();
    harness.scheduler.stop();
  });

  it("崩溃恢复时发送前 reservation 仍阻止 24 小时内重复采集", async () => {
    const startedAt = Date.now();
    const harness = createHarness({
      state: { reportReservedAt: startedAt },
    });
    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(TEST_TIMING.dailyIntervalMs - 1);

    expect(harness.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.scan).toHaveBeenCalledOnce();
    harness.scheduler.stop();
  });

  it("重启发生在基础到期点时仍等待已分配的 daily jitter", async () => {
    const harness = createHarness({
      dailyJitterMaxMs: 1,
      deviceMid: "device-2",
      state: { lastReportedAt: Date.now() - TEST_TIMING.dailyIntervalMs },
    });

    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.scan).toHaveBeenCalledOnce();
    harness.scheduler.stop();
  });

  it("扫描期间新的运行任务会终止当前扫描且不发送样本", async () => {
    let busy = false;
    const report = vi.fn();
    const scan = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<ZCodeDataSizeScanResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const scheduler = createZCodeDataSizeTelemetryScheduler({
      deviceMid: "device-1",
      getSystemIdleTimeSeconds: () => 300,
      isAppBackground: () => true,
      isZCodeBusy: () => busy,
      logger: { info: vi.fn(), warn: vi.fn() },
      readState: async () => null,
      report,
      scan,
      timing: TEST_TIMING,
      writeState: vi.fn(async () => {}),
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledOnce();

    busy = true;
    await vi.advanceTimersByTimeAsync(TEST_TIMING.activityPollMs);

    expect(report).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("扫描在 activity poll 前完成时仍会复查新启动的任务", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      onScan: () => harness.setBusy(true),
    });

    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });

  it("写入上报 reservation 期间启动的新任务仍会阻止发送", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      onWriteState: () => harness.setBusy(true),
    });

    await harness.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.scan).toHaveBeenCalledOnce();
    expect(harness.report).not.toHaveBeenCalled();
    harness.scheduler.stop();
  });
});

describe("ZCode data size telemetry state", () => {
  let rootPath = "";

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "zcode-data-size-state-"));
  });

  afterEach(async () => {
    if (rootPath) {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it("原子持久化最近成功上报时间供重启后限频", async () => {
    const stateFile = join(rootPath, "nested", "telemetry.json");

    await writeZCodeDataSizeTelemetryState(stateFile, {
      lastReportedAt: 1_777_777_777_777,
    });

    await expect(readZCodeDataSizeTelemetryState(stateFile)).resolves.toEqual({
      lastReportedAt: 1_777_777_777_777,
    });
  });

  it("原子持久化发送前 reservation 供崩溃恢复后限频", async () => {
    const stateFile = join(rootPath, "nested", "telemetry-reservation.json");

    await writeZCodeDataSizeTelemetryState(stateFile, {
      reportReservedAt: 1_777_777_777_777,
    });

    await expect(readZCodeDataSizeTelemetryState(stateFile)).resolves.toEqual({
      reportReservedAt: 1_777_777_777_777,
    });
  });

  it("状态文件不存在时显式返回无历史状态", async () => {
    await expect(
      readZCodeDataSizeTelemetryState(join(rootPath, "missing.json")),
    ).resolves.toBeNull();
  });

  it("状态文件损坏时保留读取失败语义", async () => {
    const stateFile = join(rootPath, "corrupted.json");
    await writeFile(stateFile, '{"lastReportedAt":');

    await expect(readZCodeDataSizeTelemetryState(stateFile)).rejects.toThrow();
  });

  it("状态字段格式非法时不降级为无历史状态", async () => {
    const stateFile = join(rootPath, "invalid.json");
    await writeFile(stateFile, '{"lastReportedAt":"invalid"}');

    await expect(readZCodeDataSizeTelemetryState(stateFile)).rejects.toThrow(
      "Invalid lastReportedAt",
    );
  });
});

describe("buildZCodeDataSizeArmsPayload", () => {
  it("把 partial 下界和扫描质量写入独立事件且不携带本地路径", () => {
    const payload = buildZCodeDataSizeArmsPayload({
      context: {
        appVersion: "3.9.3",
        armsEnv: "prod",
        dataRootKind: "custom",
        deviceMid: "device-1",
        platform: "darwin",
      },
      result: {
        bytes: 1024,
        directoriesScanned: 20,
        durationMs: 30_000,
        filesScanned: 200_000,
        partialReason: "file_limit",
        scanErrorCount: 2,
        status: "partial",
      },
    });

    expect(payload).toEqual({
      group: "resource",
      name: "perf_resource_zcode_data_size",
      properties: {
        app_version: "3.9.3",
        arms_env: "prod",
        data_root_kind: "custom",
        device_mid: "device-1",
        directories_scanned: "20",
        event_name: "perf_resource_zcode_data_size",
        files_scanned: "200000",
        metric_kind: "zcode_data_bytes",
        metric_value: "1024",
        partial_reason: "file_limit",
        platform: "macos",
        scan_duration_ms: "30000",
        scan_error_count: "2",
        scan_status: "partial",
        schema_version: "1",
        zcode_data_bytes: "1024",
      },
      type: "custom",
      value: 1024,
    });
    expect(Object.keys(payload.properties)).not.toContain("path");
    expect(JSON.stringify(payload)).not.toContain("/Users/");
  });
});
