import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCustom = vi.fn();
const setConfig = vi.fn();
const registerCrashEventMonitor = vi.fn();
const fromWebContents = vi.fn(() => null as unknown);
const getResourceManagerWindowId = vi.fn(() => null as number | null);

// Bugfix: 这些断言覆盖稳定性上报的纯映射与阈值逻辑，不需要真实 Electron/main 依赖。
// 全量单测里真实 Electron 入口首次加载可能超过 5s，导致无关运行时成本压垮纯函数测试。
vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
    getFocusedWindow: vi.fn(() => null),
  },
}));

vi.mock("@arms/rum-electron", () => ({
  default: {
    sendCustom,
    setConfig,
  },
}));

vi.mock("@zcode/shared", () => ({
  mapZCodeEnvToArmsRumEnv: vi.fn(() => "local"),
}));

vi.mock("../src/main/desktopCrashCapture.js", () => ({
  registerCrashEventMonitor,
}));

vi.mock("../src/main/resourceManagerWindow.js", () => ({
  getResourceManagerWindowId,
}));

describe("desktopStabilityTelemetry", () => {
  beforeEach(() => {
    sendCustom.mockClear();
    setConfig.mockClear();
    registerCrashEventMonitor.mockClear();
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
    getResourceManagerWindowId.mockReset();
    getResourceManagerWindowId.mockReturnValue(null);
    vi.resetModules();
  });

  describe("classifyRenderProcessCrash", () => {
    it("separates the crashed surface from the crash cause", async () => {
      const { classifyRenderProcessCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(
        classifyRenderProcessCrash({
          reason: "oom",
          exitCode: -1,
          webContentsType: "webview",
        }),
      ).toEqual({
        crashKind: "oom",
        crashScope: "embedded_webview",
        crashCause: "oom",
      });
      expect(
        classifyRenderProcessCrash({
          reason: "crashed",
          exitCode: 1,
          webContentsType: "window",
        }),
      ).toEqual({
        crashKind: "native",
        crashScope: "main_window_renderer",
        crashCause: "process_crashed",
      });
    });

    it("returns null for killed and clean-exit", async () => {
      const { classifyRenderProcessCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(
        classifyRenderProcessCrash({
          reason: "killed",
          exitCode: 0,
          webContentsType: "renderer",
        }),
      ).toBeNull();
      expect(
        classifyRenderProcessCrash({
          reason: "clean-exit",
          exitCode: 0,
          webContentsType: "renderer",
        }),
      ).toBeNull();
    });

    it("maps all non-OOM process crashes to native instead of calling them JS errors", async () => {
      const { classifyRenderProcessCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(
        classifyRenderProcessCrash({
          reason: "abnormal-exit",
          exitCode: 1,
          webContentsType: "renderer",
        }),
      ).toEqual({
        crashKind: "native",
        crashScope: "main_window_renderer",
        crashCause: "abnormal_exit",
      });
    });

    it("classifies memory eviction as an OOM crash", async () => {
      const { classifyRenderProcessCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");

      expect(
        classifyRenderProcessCrash({
          reason: "memory-eviction",
          exitCode: 137,
          webContentsType: "window",
        }),
      ).toEqual({
        crashKind: "oom",
        crashScope: "main_window_renderer",
        crashCause: "oom",
      });
    });
  });

  it("reports each crash callback once with count semantics and schema-v2 dimensions", async () => {
    const {
      configureDesktopStabilityTelemetry,
      registerDesktopStabilityMonitors,
      registerStabilityMainWindow,
    } = await import("../src/main/desktopStabilityTelemetry.js");
    configureDesktopStabilityTelemetry({
      deviceMid: "test-device",
      platform: "darwin",
      appVersion: "0.0.0-test",
      armsEnv: "local",
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const mainWindow = {
      id: 101,
      isDestroyed: () => false,
      once: vi.fn(),
    };
    const auxiliaryWindow = {
      id: 102,
      isDestroyed: () => false,
      once: vi.fn(),
    };
    registerStabilityMainWindow(mainWindow as never);
    getResourceManagerWindowId.mockReturnValue(auxiliaryWindow.id);
    fromWebContents.mockImplementation((webContents: unknown) =>
      (webContents as { id: number }).id === 11 ? mainWindow : auxiliaryWindow,
    );
    registerDesktopStabilityMonitors(logger, {} as never);
    const hooks = registerCrashEventMonitor.mock.calls[0]?.[2] as {
      onRenderProcessGone: (
        webContents: {
          id: number;
          getType: () => string;
        },
        details: { reason: string; exitCode: number },
      ) => void;
    };

    hooks.onRenderProcessGone(
      { id: 11, getType: () => "window" },
      { reason: "crashed", exitCode: 139 },
    );
    hooks.onRenderProcessGone(
      { id: 12, getType: () => "window" },
      { reason: "crashed", exitCode: 139 },
    );

    const reports = sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_crash");
    expect(reports).toHaveLength(2);
    expect(reports[0]?.[0]).toMatchObject({
      value: 1,
      properties: expect.objectContaining({
        telemetry_schema_version: "2",
        crash_kind: "native",
        crash_scope: "main_window_renderer",
        crash_cause: "process_crashed",
        crash_source: "electron_callback",
        web_contents_id: "11",
        metric_value: "1",
      }),
    });
    expect(reports[0]?.[0].properties.crash_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(reports[1]?.[0].properties).toMatchObject({
      crash_scope: "auxiliary_window_renderer",
      scene_window: "process_monitor",
    });
  });

  it("logs controlled process exits as info instead of console error", async () => {
    const { configureDesktopStabilityTelemetry, registerDesktopStabilityMonitors } =
      await import("../src/main/desktopStabilityTelemetry.js");
    configureDesktopStabilityTelemetry({
      deviceMid: "test-device",
      platform: "darwin",
      appVersion: "0.0.0-test",
      armsEnv: "local",
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    registerDesktopStabilityMonitors(logger, {} as never);
    const hooks = registerCrashEventMonitor.mock.calls[0]?.[2] as {
      onRenderProcessGone: (
        webContents: { id: number; getType: () => string },
        details: { reason: string; exitCode: number },
      ) => void;
      onChildProcessGone: (details: {
        type: string;
        reason: string;
        exitCode: number;
        serviceName?: string;
        name?: string;
      }) => void;
    };

    hooks.onRenderProcessGone(
      { id: 21, getType: () => "window" },
      { reason: "clean-exit", exitCode: 0 },
    );
    hooks.onChildProcessGone({
      type: "Utility",
      reason: "killed",
      exitCode: 0,
      name: "Network Service",
    });

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "[stability] perf_process_exit reported",
      expect.objectContaining({ exit_kind: "normal" }),
    );
    expect(logger.error).not.toHaveBeenCalled();

    hooks.onChildProcessGone({
      type: "Utility",
      reason: "crashed",
      exitCode: 34,
      name: "Network Service",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[stability] perf_process_exit reported",
      expect.objectContaining({ exit_kind: "recoverable_child_crash" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("uses Electron serviceName to attribute Host crashes", async () => {
    const { configureDesktopStabilityTelemetry, registerDesktopStabilityMonitors } =
      await import("../src/main/desktopStabilityTelemetry.js");
    configureDesktopStabilityTelemetry({
      deviceMid: "test-device",
      platform: "darwin",
      appVersion: "0.0.0-test",
      armsEnv: "local",
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    registerDesktopStabilityMonitors(logger, {} as never);
    const hooks = registerCrashEventMonitor.mock.calls[0]?.[2] as {
      onChildProcessGone: (details: {
        type: string;
        reason: string;
        exitCode: number;
        serviceName?: string;
        name?: string;
      }) => void;
    };

    hooks.onChildProcessGone({
      type: "Utility",
      reason: "abnormal-exit",
      exitCode: 1,
      serviceName: "zcode-host-local-1",
      name: "Node Utility Process",
    });

    const report = sendCustom.mock.calls.find((call) => call[0]?.name === "perf_crash")?.[0];
    expect(report).toMatchObject({
      name: "perf_crash",
      properties: expect.objectContaining({
        crash_scope: "host",
        process_role: "host",
        process_name: "zcode-host-local-1",
      }),
    });
  });

  it.each(["oom", "memory-eviction"])(
    "classifies Host %s exits as OOM crashes",
    async (reason) => {
      const { configureDesktopStabilityTelemetry, registerDesktopStabilityMonitors } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "darwin",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      registerDesktopStabilityMonitors(logger, {} as never);
      const hooks = registerCrashEventMonitor.mock.calls[0]?.[2] as {
        onChildProcessGone: (details: {
          type: string;
          reason: string;
          exitCode: number;
          serviceName?: string;
          name?: string;
        }) => void;
      };

      hooks.onChildProcessGone({
        type: "Utility",
        reason,
        exitCode: 137,
        serviceName: "zcode-host-local-1",
        name: "Node Utility Process",
      });

      const report = sendCustom.mock.calls.find((call) => call[0]?.name === "perf_crash")?.[0];
      expect(report).toMatchObject({
        name: "perf_crash",
        properties: expect.objectContaining({
          crash_kind: "oom",
          crash_cause: "oom",
          crash_scope: "host",
          process_role: "host",
        }),
      });
    },
  );

  describe("child process crash reporting", () => {
    it("does not report recoverable Chromium GPU and utility process exits as crash", async () => {
      const { shouldReportChildProcessGoneAsCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");

      expect(
        shouldReportChildProcessGoneAsCrash({
          type: "GPU",
          reason: "crashed",
          exitCode: 34,
          name: "",
        }),
      ).toBe(false);
      expect(
        shouldReportChildProcessGoneAsCrash({
          type: "Utility",
          reason: "crashed",
          exitCode: -1073741205,
          name: "Video Capture",
        }),
      ).toBe(false);
      expect(
        shouldReportChildProcessGoneAsCrash({
          type: "Utility",
          reason: "crashed",
          exitCode: -1073741205,
          name: "Network Service",
        }),
      ).toBe(false);
    });

    it("reports zcode host child process exits as crash", async () => {
      const { mapChildProcessGoneToProcessRole, shouldReportChildProcessGoneAsCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");

      expect(mapChildProcessGoneToProcessRole("Utility", "zcode-host-local-1")).toBe("host");
      expect(
        shouldReportChildProcessGoneAsCrash({
          type: "Utility",
          reason: "abnormal-exit",
          exitCode: 256,
          name: "zcode-host-local-1",
        }),
      ).toBe(true);
    });

    it("does not report clean child exits as crash", async () => {
      const { shouldReportChildProcessGoneAsCrash } =
        await import("../src/main/desktopStabilityTelemetry.js");

      expect(
        shouldReportChildProcessGoneAsCrash({
          type: "Utility",
          reason: "clean-exit",
          exitCode: 0,
          name: "zcode-host-local-1",
        }),
      ).toBe(false);
    });
  });

  describe("shouldReportAnr", () => {
    it("does not report below 5s threshold", async () => {
      const { shouldReportAnr, STABILITY_ANR_THRESHOLD_MS } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(shouldReportAnr(STABILITY_ANR_THRESHOLD_MS - 100, false)).toBe(false);
      expect(shouldReportAnr(4_900, false)).toBe(false);
    });

    it("reports at 5s and only once", async () => {
      const { shouldReportAnr, STABILITY_ANR_THRESHOLD_MS } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(shouldReportAnr(STABILITY_ANR_THRESHOLD_MS, false)).toBe(true);
      expect(shouldReportAnr(STABILITY_ANR_THRESHOLD_MS, true)).toBe(false);
    });
  });

  describe("shouldReportFreeze", () => {
    it("does not report freeze below 30s", async () => {
      const { shouldReportFreeze } = await import("../src/main/desktopStabilityTelemetry.js");
      expect(shouldReportFreeze(29_900, false, false)).toBe(false);
    });

    it("reports freeze at 30s when no crash", async () => {
      const { shouldReportFreeze, STABILITY_FREEZE_THRESHOLD_MS } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(shouldReportFreeze(STABILITY_FREEZE_THRESHOLD_MS, false, false)).toBe(true);
    });

    it("does not report freeze after crash", async () => {
      const { shouldReportFreeze, STABILITY_FREEZE_THRESHOLD_MS } =
        await import("../src/main/desktopStabilityTelemetry.js");
      expect(shouldReportFreeze(STABILITY_FREEZE_THRESHOLD_MS, false, true)).toBe(false);
    });
  });

  it("attributes ANR to an auxiliary BrowserWindow instead of main", async () => {
    vi.useFakeTimers();
    try {
      const {
        configureDesktopStabilityTelemetry,
        registerDesktopStabilityMonitors,
        STABILITY_ANR_THRESHOLD_MS,
      } = await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "darwin",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const webContentsHandlers = new Map<string, () => void>();
      const webContents = {
        id: 401,
        getURL: () => "file:///about.html",
        on: vi.fn((event: string, handler: () => void) => {
          webContentsHandlers.set(event, handler);
        }),
      };
      const auxiliaryWindow = {
        id: 402,
        isDestroyed: () => false,
        webContents,
      };

      registerDesktopStabilityMonitors(logger, {} as never);
      const hooks = registerCrashEventMonitor.mock.calls[0]?.[2] as {
        onBrowserWindowCreated: (win: typeof auxiliaryWindow) => void;
      };
      hooks.onBrowserWindowCreated(auxiliaryWindow);
      webContentsHandlers.get("unresponsive")?.();

      vi.advanceTimersByTime(STABILITY_ANR_THRESHOLD_MS);

      const report = sendCustom.mock.calls.find((call) => call[0]?.name === "perf_anr")?.[0];
      expect(report).toMatchObject({
        name: "perf_anr",
        properties: expect.objectContaining({
          scene_window: "other",
          window_id: "402",
          web_contents_id: "401",
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("Agent process ARMS reporting", () => {
    it("reports every unexpected Agent exit with count and sanitized error detail", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "darwin",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const workspacePath = "/Users/alice/private-project";
      const event = {
        type: "agent-process-exited" as const,
        pid: 12345,
        provider: "glm" as const,
        workspacePath,
        runtimeInstanceId: "runtime-test-1",
        exitCode: 1,
        signal: null,
        endedAt: 200,
        terminationKind: "unexpected" as const,
        runtimeReady: true,
        runtimeGeneration: 3,
        uptimeMs: 100,
        stderrLineCount: 7,
        stderrTail: [
          `Error: write EPIPE token=super-secret at ${workspacePath}`,
          "request URL contains sk-1234567890abcdefghijklmnopqrstuv",
          `    at Socket._write (${workspacePath}/child.js:10:20)`,
          "    at open (/Users/bob/.zcode/state.db:30:40)",
          "    at load (/opt/zcode-private/tool.js:50:60)",
          "  code: 'EPIPE',",
          "x".repeat(1_000),
          "x".repeat(1_000),
          "x".repeat(1_000),
          "x".repeat(1_000),
        ],
      };

      reportAgentProcessExitToArms(event, logger);
      reportAgentProcessExitToArms({ ...event, pid: 12346 }, logger);

      const reports = sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash");
      expect(reports).toHaveLength(2);
      expect(reports[0][0]).toMatchObject({
        name: "perf_agent_crash",
        type: "custom",
        group: "stability",
        value: 1,
        properties: expect.objectContaining({
          process_role: "agent",
          incident_kind: "unexpected_exit",
          exit_code: "1",
          error_name: "Error",
          error_code: "EPIPE",
          error_message: "write EPIPE token=<redacted> at <workspace>",
          runtime_instance_id: "runtime-test-1",
          runtime_generation: "3",
          stderr_line_count: "7",
          crash_phase: "runtime",
          termination_class: "exit_nonzero",
          diagnostic_class: "errno",
        }),
      });
      const properties = reports[0][0].properties as Record<string, string>;
      expect(properties.error_stack).toContain("<workspace>");
      expect(properties.error_stack).not.toContain(workspacePath);
      expect(properties.error_stack).not.toContain("/Users/bob");
      expect(properties.error_stack).not.toContain("/opt/zcode-private");
      expect(properties.error_stack).toContain("<home>/.zcode/state.db");
      expect(properties.error_stack).toContain("<path>");
      expect(properties.error_stack).not.toContain("super-secret");
      expect(properties.error_stack).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
      expect(properties.error_stack).toContain("sk-<redacted>");
      expect(properties.error_stack).toHaveLength(4_000);
      expect(properties.error_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it.each([
      {
        name: "OOM",
        runtimeReady: false,
        stderrTail: [
          "<--- Last few GCs --->",
          "[189964:0x18a8001c8000] Mark-Compact 3691 MB",
          "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
          "----- Native stack trace -----",
          " 1: 0x00007ff6deadbeef",
        ],
        expected: {
          crash_phase: "startup",
          diagnostic_class: "oom",
          error_name: "AgentOutOfMemory",
          error_code: "ERR_OUT_OF_MEMORY",
          error_message: "CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
        },
      },
      {
        name: "SQLite",
        runtimeReady: true,
        stderrTail: [
          "Error: SQLite migration initialization failed for C:\\Users\\alice\\.zcode\\cli\\db\\db.sqlite",
        ],
        expected: {
          crash_phase: "runtime",
          diagnostic_class: "sqlite",
          error_name: "Error",
          error_code: "",
          error_message:
            "SQLite migration initialization failed for <home>/.zcode/cli/db/db.sqlite",
        },
      },
      {
        name: "errno",
        runtimeReady: false,
        stderrTail: [
          "[Object]",
          "node:events:486",
          "EPERM: process.cwd failed with error operation not permitted, uv_cwd",
          "1: 0x00007ff6deadbeef",
        ],
        expected: {
          crash_phase: "startup",
          diagnostic_class: "errno",
          error_name: "AgentProcessExit",
          error_code: "EPERM",
          error_message: "EPERM: process.cwd failed with error operation not permitted, uv_cwd",
        },
      },
      {
        name: "noise only",
        runtimeReady: false,
        stderrTail: [
          "[Object], [Object], [Object],",
          "<--- Last few GCs --->",
          "----- Native stack trace -----",
          "1: 0x00007ff6deadbeef",
          "(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
          "(Use `ZCode --trace-warnings ...` to show where the warning was created)",
          "},",
        ],
        expected: {
          crash_phase: "startup",
          diagnostic_class: "none",
          error_name: "AgentProcessExit",
          error_code: "",
          error_message: "Agent process exited unexpectedly (code=1, signal=null)",
        },
      },
    ])(
      "extracts a stable $name diagnostic summary",
      async ({ runtimeReady, stderrTail, expected }) => {
        const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
          await import("../src/main/desktopStabilityTelemetry.js");
        configureDesktopStabilityTelemetry({
          deviceMid: "test-device",
          platform: "win32",
          appVersion: "0.0.0-test",
          armsEnv: "local",
        });
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        reportAgentProcessExitToArms(
          {
            type: "agent-process-exited",
            pid: 12345,
            provider: "glm",
            workspacePath: "C:\\repo",
            runtimeInstanceId: `runtime-${expected.diagnostic_class}`,
            exitCode: 1,
            signal: null,
            endedAt: 200,
            terminationKind: "unexpected",
            runtimeReady,
            runtimeGeneration: 1,
            uptimeMs: 100,
            stderrLineCount: stderrTail.length,
            stderrTail,
          },
          logger,
        );

        const properties = sendCustom.mock.calls.find(
          (call) => call[0]?.name === "perf_agent_crash",
        )?.[0].properties;
        expect(properties).toMatchObject({
          ...expected,
          termination_class: "exit_nonzero",
        });
        expect(properties.error_message).not.toMatch(/^\[Object\]|^\d+:\s*0x|^<---|^-----/);
      },
    );

    it.each(["app_quit", "update_install"] as const)(
      "keeps %s lifecycle active and suppresses late Agent exits",
      async (scene) => {
        const {
          configureDesktopStabilityTelemetry,
          getStabilityLifecycleScene,
          notifyStabilityAppExit,
          reportAgentProcessExitToArms,
        } = await import("../src/main/desktopStabilityTelemetry.js");
        configureDesktopStabilityTelemetry({
          deviceMid: "test-device",
          platform: "win32",
          appVersion: "0.0.0-test",
          armsEnv: "local",
        });
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        notifyStabilityAppExit(scene, logger, { exitCode: 0, exitKind: "normal" });
        sendCustom.mockClear();
        reportAgentProcessExitToArms(
          {
            type: "agent-process-exited",
            pid: 12345,
            provider: "glm",
            workspacePath: "C:\\repo",
            runtimeInstanceId: "runtime-shutdown",
            exitCode: 1073807364,
            signal: null,
            endedAt: 200,
            terminationKind: "unexpected",
            runtimeGeneration: 1,
            uptimeMs: 100,
            stderrLineCount: 0,
          },
          logger,
        );

        expect(getStabilityLifecycleScene()).toBe(scene);
        expect(
          sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash"),
        ).toHaveLength(0);
      },
    );

    it.each([
      {
        name: "Windows 0x40010004",
        platform: "win32" as const,
        exitCode: 0x40010004,
        signal: null,
      },
      {
        name: "POSIX SIGTERM",
        platform: "linux" as const,
        exitCode: null,
        signal: "SIGTERM",
      },
    ])("does not report controlled termination signature: $name", async (input) => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: input.platform,
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      reportAgentProcessExitToArms(
        {
          type: "agent-process-exited",
          pid: 12345,
          provider: "glm",
          workspacePath: input.platform === "win32" ? "C:\\repo" : "/repo",
          runtimeInstanceId: "runtime-controlled-termination",
          exitCode: input.exitCode,
          signal: input.signal,
          endedAt: 200,
          terminationKind: "unexpected",
          runtimeGeneration: 1,
          uptimeMs: 100,
          stderrLineCount: 0,
        },
        logger,
      );

      expect(
        sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash"),
      ).toHaveLength(0);
    });

    it.each([
      {
        name: "Windows 0x40010004",
        platform: "win32" as const,
        workspacePath: "C:\\repo",
        exitCode: 0x40010004,
        signal: null,
        terminationClass: "exit_nonzero",
      },
      {
        name: "POSIX SIGTERM",
        platform: "linux" as const,
        workspacePath: "/repo",
        exitCode: null,
        signal: "SIGTERM",
        terminationClass: "signal",
      },
    ])("reports protocol failure after controlled cleanup: $name", async (input) => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: input.platform,
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      reportAgentProcessExitToArms(
        {
          type: "agent-process-exited",
          pid: 12345,
          provider: "glm",
          workspacePath: input.workspacePath,
          runtimeInstanceId: "runtime-protocol-failure",
          exitCode: input.exitCode,
          signal: input.signal,
          endedAt: 200,
          terminationKind: "unexpected",
          terminationReason: "protocol-close",
          runtimeGeneration: 1,
          uptimeMs: 100,
          stderrLineCount: 0,
        },
        logger,
      );

      const reports = sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.[0].properties).toMatchObject({
        termination_class: input.terminationClass,
        termination_reason: "protocol-close",
      });
    });

    it("still reports an unexpected SIGKILL during runtime", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "linux",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      reportAgentProcessExitToArms(
        {
          type: "agent-process-exited",
          pid: 12345,
          provider: "glm",
          workspacePath: "/repo",
          runtimeInstanceId: "runtime-sigkill",
          exitCode: null,
          signal: "SIGKILL",
          endedAt: 200,
          terminationKind: "unexpected",
          runtimeGeneration: 1,
          uptimeMs: 100,
          stderrLineCount: 0,
        },
        logger,
      );

      const reports = sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.[0].properties).toMatchObject({
        crash_phase: "unknown",
        termination_class: "signal",
      });
    });

    it("classifies an unexpected clean code as exit_zero crash", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "linux",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      reportAgentProcessExitToArms(
        {
          type: "agent-process-exited",
          pid: 12345,
          provider: "glm",
          workspacePath: "/repo",
          runtimeInstanceId: "runtime-exit-zero",
          exitCode: 0,
          signal: null,
          endedAt: 200,
          terminationKind: "unexpected",
          runtimeReady: true,
          runtimeGeneration: 1,
          uptimeMs: 100,
          stderrLineCount: 0,
        },
        logger,
      );

      expect(
        sendCustom.mock.calls.find((call) => call[0]?.name === "perf_agent_crash")?.[0].properties,
      ).toMatchObject({
        crash_phase: "runtime",
        termination_class: "exit_zero",
      });
    });

    it("does not report expected or watchdog Agent exits", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "win32",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const base = {
        type: "agent-process-exited" as const,
        pid: 12345,
        provider: "glm" as const,
        workspacePath: "C:\\repo",
        runtimeInstanceId: "runtime-test-2",
        exitCode: 1,
        signal: null,
        endedAt: 200,
        runtimeGeneration: 1,
        uptimeMs: 100,
        stderrLineCount: 0,
      };

      reportAgentProcessExitToArms(
        {
          ...base,
          terminationKind: "expected",
          terminationReason: "workspace-dispose",
        },
        logger,
      );
      reportAgentProcessExitToArms(
        {
          ...base,
          terminationKind: "watchdog_recycle",
          terminationReason: "request-timeout",
        },
        logger,
      );

      expect(
        sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_agent_crash"),
      ).toHaveLength(0);
    });

    it("normalizes home paths and uses the meaningful errno line for Agent fingerprints", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessExitToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "darwin",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const base = {
        type: "agent-process-exited" as const,
        pid: 12345,
        provider: "glm" as const,
        workspacePath: "/repo",
        exitCode: 1,
        signal: null,
        endedAt: 200,
        terminationKind: "unexpected" as const,
        runtimeGeneration: 1,
        uptimeMs: 100,
        stderrLineCount: 3,
      };

      reportAgentProcessExitToArms(
        {
          ...base,
          runtimeInstanceId: "runtime-path-a",
          stderrTail: [
            "[Object]",
            "node:events:486",
            "EPERM: process.cwd failed at /Users/alice/.zcode/state.db:10:20",
          ],
        },
        logger,
      );
      reportAgentProcessExitToArms(
        {
          ...base,
          runtimeInstanceId: "runtime-path-b",
          stderrTail: [
            "[Object]",
            "node:events:999",
            "EPERM: process.cwd failed at /home/bob/.zcode/state.db:30:40",
          ],
        },
        logger,
      );

      const reports = sendCustom.mock.calls
        .filter((call) => call[0]?.name === "perf_agent_crash")
        .map((call) => call[0].properties as Record<string, string>);
      expect(reports.map((report) => report.error_message)).toEqual([
        "EPERM: process.cwd failed at <home>/.zcode/state.db:10:20",
        "EPERM: process.cwd failed at <home>/.zcode/state.db:30:40",
      ]);
      expect(reports.map((report) => report.error_code)).toEqual(["EPERM", "EPERM"]);
      expect(reports[0]?.error_fingerprint).toBe(reports[1]?.error_fingerprint);
    });

    it("reports Agent spawn errors without command or workspace paths", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessSpawnErrorToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "linux",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const workspacePath = "/home/alice/private-project";

      reportAgentProcessSpawnErrorToArms(
        {
          type: "agent-process-error",
          pid: null,
          provider: "glm",
          workspacePath,
          runtimeInstanceId: "runtime-test-3",
          command: `${workspacePath}/missing-agent`,
          args: ["app-server", "--stdio", "--token=must-not-upload"],
          errorName: "Error",
          errorCode: "ENOENT",
          errorMessage: `spawn ${workspacePath}/missing-agent ENOENT sk-abcdefghijklmnopqrstuv0123456789`,
          errorStack: `Error: spawn ${workspacePath}/missing-agent ENOENT sk-abcdefghijklmnopqrstuv0123456789`,
          runtimeGeneration: 1,
          occurredAt: 100,
        },
        logger,
      );

      const report = sendCustom.mock.calls.find(
        (call) => call[0]?.name === "perf_agent_spawn_error",
      )?.[0];
      expect(report).toMatchObject({
        name: "perf_agent_spawn_error",
        type: "custom",
        group: "stability",
        value: 1,
        properties: expect.objectContaining({
          process_role: "agent",
          incident_kind: "spawn_error",
          error_code: "ENOENT",
          error_message: "spawn <workspace>/missing-agent ENOENT sk-<redacted>",
          diagnostic_class: "errno",
          runtime_instance_id: "runtime-test-3",
        }),
      });
      expect(JSON.stringify(report)).not.toContain(workspacePath);
      expect(JSON.stringify(report)).not.toContain("must-not-upload");
      expect(JSON.stringify(report)).not.toContain("sk-abcdefghijklmnopqrstuv0123456789");
      expect(JSON.stringify(report)).toContain("sk-<redacted>");
    });

    it("reports one Agent start with the runtime instance used by its later crash", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessStartToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "linux",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      reportAgentProcessStartToArms(
        {
          type: "agent-process-spawned",
          pid: 12345,
          provider: "glm",
          workspacePath: "/repo/demo",
          command: "/tmp/zcode-agent",
          args: ["app-server", "--stdio"],
          startedAt: 100,
          runtimeGeneration: 4,
          runtimeInstanceId: "runtime-test-4",
        },
        logger,
      );

      expect(
        sendCustom.mock.calls.find((call) => call[0]?.name === "perf_agent_start")?.[0],
      ).toMatchObject({
        name: "perf_agent_start",
        value: 1,
        properties: expect.objectContaining({
          process_role: "agent",
          runtime_generation: "4",
          runtime_instance_id: "runtime-test-4",
        }),
      });
    });

    it("reports Agent ready with the same runtime instance and startup duration", async () => {
      const { configureDesktopStabilityTelemetry, reportAgentProcessReadyToArms } =
        await import("../src/main/desktopStabilityTelemetry.js");
      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "linux",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      reportAgentProcessReadyToArms(
        {
          type: "agent-process-ready",
          pid: 12345,
          provider: "glm",
          workspacePath: "/repo/demo",
          readyAt: 250,
          startupDurationMs: 150,
          runtimeGeneration: 4,
          runtimeInstanceId: "runtime-test-4",
        },
        logger,
      );

      expect(
        sendCustom.mock.calls.find((call) => call[0]?.name === "perf_agent_ready")?.[0],
      ).toMatchObject({
        name: "perf_agent_ready",
        value: 1,
        properties: expect.objectContaining({
          process_role: "agent",
          runtime_generation: "4",
          runtime_instance_id: "runtime-test-4",
          startup_duration_ms: "150",
        }),
      });
    });
  });

  describe("reportPerfAppStart", () => {
    it("sends perf_app_start only once per process", async () => {
      const { configureDesktopStabilityTelemetry, reportPerfAppStart } =
        await import("../src/main/desktopStabilityTelemetry.js");

      configureDesktopStabilityTelemetry({
        deviceMid: "test-device",
        platform: "darwin",
        appVersion: "0.0.0-test",
        armsEnv: "local",
      });

      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      reportPerfAppStart(logger);
      reportPerfAppStart(logger);

      const perfStarts = sendCustom.mock.calls.filter((call) => call[0]?.name === "perf_app_start");
      expect(perfStarts).toHaveLength(1);
      expect(perfStarts[0][0]).toMatchObject({
        name: "perf_app_start",
        type: "custom",
        group: "stability",
        value: 1,
      });
      expect(perfStarts[0][0].properties).toMatchObject({
        event_name: "perf_app_start",
        scene_lifecycle: "cold_start",
        scene_window: "main",
        device_mid: "test-device",
        telemetry_schema_version: "2",
      });
    });
  });
});
