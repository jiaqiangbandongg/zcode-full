import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZCODE_AGENT_LIFECYCLE_LOG_MARKER } from "@zcode/shared/process-diagnostic";

const init = vi.fn((_config: unknown) => Promise.resolve());

vi.mock("@arms/rum-electron", () => ({
  default: { init, client: { useReporter: vi.fn() } },
}));

vi.mock("../src/main/desktopDeviceMid.js", () => ({
  ensureDesktopDeviceMidSync: vi.fn(() => "test-device-mid"),
}));

vi.mock("../src/main/desktopNetworkTelemetry.js", () => ({
  ingestArmsApiEventsFromBatch: vi.fn(),
}));

vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  desktopRuntimeEnv: "development",
  runtimeApplicationName: "zcode-test",
}));

vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zcode/shared", async (importOriginal) => {
  // 脱敏收口是 beforeReport 的一部分，必须用真实实现验证；只覆写环境/版本等常量。
  const actual = await importOriginal<typeof import("@zcode/shared")>();
  return {
    ...actual,
    ZCODE_ARMS_RUM_ENDPOINT: "https://example.test/endpoint",
    ZCODE_ENV: "test",
    ZCODE_VERSION: "0.0.0-test",
    mapZCodeEnvToArmsRumEnv: vi.fn(() => "local"),
  };
});

// beforeReport 是 armsRum.init(config) 里的一个字段；直接从 mock 的 init 调用参数里取出来调用，
// 不需要走真实上报网络请求，即可验证 LoAF 归因摘要被正确合并进 event.properties。
async function getBeforeReport(): Promise<
  (payload: { events?: Array<Record<string, unknown>> }) => unknown
> {
  await import("../src/main/appARMSBootstrap.js");
  const config = init.mock.calls[0]?.[0] as unknown as {
    beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => unknown;
  };
  return config.beforeReport;
}

async function getPatchedReadCrashProcessType(): Promise<
  (input: Uint8Array) => string | undefined
> {
  const packageEntry = fileURLToPath(
    new URL("../../../node_modules/@arms/rum-electron/dist/index.mjs", import.meta.url),
  );
  const source = await readFile(packageEntry, "utf8");
  const parserStart = source.indexOf("const zcodeCrashpadInfoStreamType");
  const parserEnd = source.indexOf("\nclass ", parserStart);

  expect(parserStart).toBeGreaterThanOrEqual(0);
  expect(parserEnd).toBeGreaterThan(parserStart);
  return runInNewContext(`${source.slice(parserStart, parserEnd)}; readCrashProcessType`, {
    Buffer,
  }) as (input: Uint8Array) => string | undefined;
}

async function getPatchedFormatConsoleErrorArgs(): Promise<(args: unknown[]) => string> {
  const packageEntry = fileURLToPath(
    new URL("../../../node_modules/@arms/rum-electron/dist/index.mjs", import.meta.url),
  );
  const source = await readFile(packageEntry, "utf8");
  const formatterStart = source.indexOf("const zcodeConsoleErrorMaxLength");
  const formatterEnd = source.indexOf("\nclass ", formatterStart);

  expect(formatterStart).toBeGreaterThanOrEqual(0);
  expect(formatterEnd).toBeGreaterThan(formatterStart);
  return runInNewContext(
    `${source.slice(formatterStart, formatterEnd)}; zcodeFormatConsoleErrorArgs`,
  ) as (args: unknown[]) => string;
}

function alignToFour(value: number): number {
  return (value + 3) & ~3;
}

function buildCrashpadProcessTypeDump(options: {
  annotationKey: "process_type" | "ptype";
  processType: string;
  decoyProcessType?: string;
}): Uint8Array {
  const dump = Buffer.alloc(512);
  const directoryRva = 32;
  const crashpadInfoRva = 128;
  const moduleListRva = 192;
  const moduleInfoRva = 208;
  const annotationListRva = 236;
  const annotationNameRva = 252;
  const annotationValueRva = alignToFour(
    annotationNameRva + 4 + Buffer.byteLength(options.annotationKey) + 1,
  );

  dump.write("MDMP", 0, "ascii");
  dump.writeUInt32LE(1, 8);
  dump.writeUInt32LE(directoryRva, 12);
  dump.writeUInt32LE(0x43500001, directoryRva);
  dump.writeUInt32LE(64, directoryRva + 4);
  dump.writeUInt32LE(crashpadInfoRva, directoryRva + 8);

  if (options.decoyProcessType) {
    const decoyRva = 48;
    dump.writeUInt32LE(12, decoyRva);
    dump.write("process_type", decoyRva + 4, "utf8");
    const decoyValueLengthRva = decoyRva + 4 + 12 + 4;
    dump.writeUInt32LE(Buffer.byteLength(options.decoyProcessType), decoyValueLengthRva);
    dump.write(options.decoyProcessType, decoyValueLengthRva + 4, "utf8");
  }

  dump.writeUInt32LE(1, crashpadInfoRva);
  dump.writeUInt32LE(16, crashpadInfoRva + 44);
  dump.writeUInt32LE(moduleListRva, crashpadInfoRva + 48);

  dump.writeUInt32LE(1, moduleListRva);
  dump.writeUInt32LE(0, moduleListRva + 4);
  dump.writeUInt32LE(28, moduleListRva + 8);
  dump.writeUInt32LE(moduleInfoRva, moduleListRva + 12);

  dump.writeUInt32LE(1, moduleInfoRva);
  dump.writeUInt32LE(16, moduleInfoRva + 20);
  dump.writeUInt32LE(annotationListRva, moduleInfoRva + 24);

  dump.writeUInt32LE(1, annotationListRva);
  dump.writeUInt32LE(annotationNameRva, annotationListRva + 4);
  dump.writeUInt16LE(1, annotationListRva + 8);
  dump.writeUInt16LE(0, annotationListRva + 10);
  dump.writeUInt32LE(annotationValueRva, annotationListRva + 12);

  dump.writeUInt32LE(Buffer.byteLength(options.annotationKey), annotationNameRva);
  dump.write(options.annotationKey, annotationNameRva + 4, "utf8");
  dump.writeUInt32LE(Buffer.byteLength(options.processType), annotationValueRva);
  dump.write(options.processType, annotationValueRva + 4, "utf8");
  return dump;
}

describe("appARMSBootstrap beforeReport", () => {
  it("filters only explicitly marked lifecycle console wrappers, preserving real JS errors", async () => {
    const beforeReport = await getBeforeReport();
    const wrapper = {
      event_type: "exception",
      type: "error",
      source: "console.error",
      message: `[host-log] process exited ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}`,
    };
    const realError = { ...wrapper, source: "uncaughtException" };
    const normalConsoleError = { ...wrapper, message: "a real main error" };
    const custom = { event_type: "custom", name: "perf_agent_crash" };
    expect(
      beforeReport({ events: [wrapper, realError, normalConsoleError, custom] }),
    ).toMatchObject({
      events: [realError, normalConsoleError, custom],
    });
  });

  it("在返回 payload 前脱敏自动采集事件的界面文本、路径与 URL", async () => {
    const beforeReport = await getBeforeReport();
    const result = beforeReport({
      events: [
        {
          event_type: "click",
          name: "click on button: 重构 src/auth 登录流程...",
          snapshots: JSON.stringify({ src: "file:///Users/alice/p/a.png" }),
        },
        {
          event_type: "exception",
          type: "error",
          source: "uncaughtException",
          message: "ENOENT '/Users/alice/work/secret/a.ts' for bob@example.com",
        },
        {
          event_type: "resource",
          type: "api",
          url: "https://zcode.z.ai/api/v1/event/report?state=abc123",
        },
      ],
    }) as { events: Array<Record<string, unknown>> };

    expect(result.events[0]!.name).toBe("click on button");
    expect(result.events[0]!.snapshots).toBeUndefined();
    expect(result.events[1]!.message).not.toContain("alice");
    expect(result.events[1]!.message).not.toContain("secret");
    expect(result.events[1]!.message).not.toContain("bob@example.com");
    expect(result.events[2]!.url).toBe("https://zcode.z.ai/api/v1/event/report");
  });

  it("脱敏排在网络 ingest 之后，聚合仍拿到原始 URL", async () => {
    const { ingestArmsApiEventsFromBatch } = await import("../src/main/desktopNetworkTelemetry.js");
    // 脱敏是就地改写，mock 记录的是同一个对象引用；必须在 ingest 被调用的那一刻取快照，
    // 否则读到的是脱敏后的值，无法证明聚合看到的是原始 URL。
    const urlsSeenByAggregator: unknown[] = [];
    vi.mocked(ingestArmsApiEventsFromBatch).mockImplementation((events) => {
      for (const event of events ?? []) {
        urlsSeenByAggregator.push(event.url);
      }
    });
    const beforeReport = await getBeforeReport();
    const events = [
      {
        event_type: "resource",
        type: "api",
        url: "https://zcode.z.ai/api/v1/tasks/0f8fad5b-d9cb-469f-a165-70867728950e?token=x",
      },
    ];
    beforeReport({ events });

    expect(urlsSeenByAggregator).toEqual([
      "https://zcode.z.ai/api/v1/tasks/0f8fad5b-d9cb-469f-a165-70867728950e?token=x",
    ]);
    expect(events[0]!.url).toBe("https://zcode.z.ai/api/v1/tasks/{segment}");
  });
  beforeEach(() => {
    vi.resetModules();
    init.mockClear();
  });

  it("使用 Desktop 本地开发运行态计算 ARMS 环境", async () => {
    await import("../src/main/appARMSBootstrap.js");
    const shared = await import("@zcode/shared");
    const config = init.mock.calls[0]?.[0] as unknown as {
      env: string;
      app: { env: string };
      tracing: { sample: number };
    };

    expect(shared.mapZCodeEnvToArmsRumEnv).toHaveBeenCalledWith("development");
    expect(config).toMatchObject({
      env: "local",
      app: { env: "local" },
      tracing: { sample: 1 },
    });
  });

  it("为 longTask 事件补写归因摘要到 properties", async () => {
    const beforeReport = await getBeforeReport();
    const snapshots = JSON.stringify([
      { duration: 30, invokerType: "event-listener" },
      { duration: 90, invokerType: "user-callback" },
    ]);
    const longTaskEvent: Record<string, unknown> = {
      event_type: "longTask",
      duration: 150,
      snapshots,
    };
    const result = beforeReport({ events: [longTaskEvent] }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events[0].properties).toEqual({
      loaf_script_count: 2,
      loaf_top_duration_ms: 90,
      loaf_top_invoker_type: "user-callback",
      loaf_top_share_pct: 60,
    });
  });

  it("不影响非 longTask 事件,不新增 properties 字段", async () => {
    const beforeReport = await getBeforeReport();
    const customEvent: Record<string, unknown> = {
      event_type: "custom",
      name: "perf_ui_first_token",
      properties: { model: "test-model" },
    };
    const result = beforeReport({ events: [customEvent] }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events[0].properties).toEqual({ model: "test-model" });
  });

  it("longTask 事件缺少有效 snapshots 时不新增 properties", async () => {
    const beforeReport = await getBeforeReport();
    const longTaskEvent: Record<string, unknown> = {
      event_type: "longTask",
      duration: 150,
      snapshots: null,
    };
    const result = beforeReport({ events: [longTaskEvent] }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events[0].properties).toBeUndefined();
  });

  it("drops crashReporter dumps that do not contain the ZCode product binary", async () => {
    const beforeReport = await getBeforeReport();
    const externalCrash = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      binary_images: [{ name: "hdc" }, { name: "libsystem_kernel.dylib" }],
    };
    const zcodeCrash = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      meta: { process_type: "browser" },
      binary_images: [{ name: "zcode-test" }, { name: "Electron Framework" }],
    };
    const helperCrash = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      binary_images: [{ name: "zcode-test Helper (Renderer)" }],
    };
    const customEvent = { event_type: "custom", name: "perf_app_start" };

    const result = beforeReport({
      events: [externalCrash, helperCrash, zcodeCrash, customEvent],
    }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events).toHaveLength(2);
    expect(result.events).not.toContain(externalCrash);
    expect(result.events).not.toContain(helperCrash);
    expect(result.events).toContain(customEvent);
    expect(result.events[0]).toMatchObject({
      source: "crashReporter",
      properties: {
        telemetry_schema_version: "2",
        crash_scope: "app_native_process",
        crash_cause: "native_crash",
        crash_source: "crash_reporter_dump",
      },
    });

    const firstCrashId = (result.events[0].properties as Record<string, unknown> | undefined)
      ?.crash_id;
    const retried = beforeReport({ events: result.events }) as {
      events: Array<Record<string, unknown>>;
    };
    expect((retried.events[0].properties as Record<string, unknown> | undefined)?.crash_id).toBe(
      firstCrashId,
    );
  });

  it("does not promote an unattributed product dump into app_native_process", async () => {
    const beforeReport = await getBeforeReport();
    const dump = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      binary_images: [{ name: "zcode-test" }],
    };

    const result = beforeReport({ events: [dump] }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events[0]).toMatchObject({
      properties: {
        telemetry_schema_version: "2",
        crash_scope: "native_dump_unattributed",
        crash_cause: "native_crash",
        crash_source: "crash_reporter_dump",
        native_dump_process_role: "unknown",
      },
    });
  });

  it("uses the SDK-preserved process_type and never infers role from meta.process", async () => {
    const beforeReport = await getBeforeReport();
    const dump = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      meta: { process: "zcode-test", process_type: "browser" },
      binary_images: [{ name: "zcode-test" }],
    };

    const result = beforeReport({ events: [dump] }) as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events[0]).toMatchObject({
      properties: {
        crash_scope: "app_native_process",
        native_dump_process_role: "main",
      },
    });
  });

  it.each([
    { source: "top-level process_role", eventPatch: { process_role: "main" } },
    {
      source: "top-level native_dump_process_role",
      eventPatch: { native_dump_process_role: "main" },
    },
    { source: "meta.process_role", eventPatch: { meta: { process_role: "main" } } },
    {
      source: "properties.process_role",
      eventPatch: { properties: { process_role: "main" } },
    },
    {
      source: "properties.native_dump_process_role",
      eventPatch: { properties: { native_dump_process_role: "main" } },
    },
  ] satisfies Array<{ source: string; eventPatch: Record<string, unknown> }>)(
    "does not trust $source as a native dump process role",
    async ({ eventPatch }) => {
      const { filterAndEnrichNativeCrashEvents } = await import("../src/main/appARMSBootstrap.js");
      const dump = {
        event_type: "exception",
        type: "crash",
        source: "crashReporter",
        binary_images: [{ name: "zcode-test" }],
        ...eventPatch,
      };

      const events = filterAndEnrichNativeCrashEvents([dump], "zcode-test", "zcode-test");

      expect(events[0]).toMatchObject({
        properties: {
          crash_scope: "native_dump_unattributed",
          native_dump_process_role: "unknown",
        },
      });
    },
  );

  it.each(["process_type", "ptype"] as const)(
    "reads the structured Crashpad %s annotation",
    async (annotationKey) => {
      const readCrashProcessType = await getPatchedReadCrashProcessType();
      const dump = buildCrashpadProcessTypeDump({ annotationKey, processType: "browser" });

      expect(readCrashProcessType(dump)).toBe("browser");
    },
  );

  it("ignores unreferenced process_type bytes before the structured annotation", async () => {
    const readCrashProcessType = await getPatchedReadCrashProcessType();
    const dump = buildCrashpadProcessTypeDump({
      annotationKey: "ptype",
      processType: "renderer",
      decoyProcessType: "browser",
    });

    expect(readCrashProcessType(dump)).toBe("renderer");
  });

  it.each(["renderer", "utility", "gpu", "host"])(
    "keeps a %s dump out of app_native_process even when the product binary matches",
    async (processRole) => {
      const { filterAndEnrichNativeCrashEvents } = await import("../src/main/appARMSBootstrap.js");
      const dump = {
        event_type: "exception",
        type: "crash",
        source: "crashReporter",
        meta: { process_type: processRole },
        binary_images: [{ name: "zcode-test" }],
      };

      const events = filterAndEnrichNativeCrashEvents([dump], "zcode-test", "zcode-test");

      expect(events[0]).toMatchObject({
        properties: {
          crash_scope: "native_dump_unattributed",
          native_dump_process_role: processRole,
        },
      });
    },
  );

  it("keeps a dump attributed to the main process in app_native_process", async () => {
    const { filterAndEnrichNativeCrashEvents } = await import("../src/main/appARMSBootstrap.js");
    const dump = {
      event_type: "exception",
      type: "crash",
      source: "crashReporter",
      meta: { process_type: "browser" },
      binary_images: [{ name: "zcode-test" }],
    };

    const events = filterAndEnrichNativeCrashEvents([dump], "zcode-test", "zcode-test");

    expect(events[0]).toMatchObject({
      properties: {
        crash_scope: "app_native_process",
        native_dump_process_role: "main",
      },
    });
  });

  it.each([
    {
      runtime: "Linux Preview",
      applicationName: "ZCode Preview",
      executableName: "zcode-preview",
    },
    {
      runtime: "local development",
      applicationName: "ZCode Dev",
      executableName: "Electron",
    },
  ])(
    "keeps a $runtime dump whose executable name differs from the application name",
    async ({ applicationName, executableName }) => {
      const { filterAndEnrichNativeCrashEvents } = await import("../src/main/appARMSBootstrap.js");
      const crash = {
        event_type: "exception",
        type: "crash",
        source: "crashReporter",
        meta: { process_type: "browser" },
        binary_images: [{ name: executableName }],
      };

      const events = filterAndEnrichNativeCrashEvents([crash], applicationName, executableName);

      expect(events).toEqual([crash]);
    },
  );
});

describe("patched ARMS console error formatter", () => {
  it.each(["main", "renderer"])(
    "removes the %s logger prefix and preserves every meaningful argument",
    async (source) => {
      const formatConsoleErrorArgs = await getPatchedFormatConsoleErrorArgs();

      expect(
        formatConsoleErrorArgs([
          `[2026-08-20 17:04:22.265] [pid:25144] [${source}]`,
          "[stability] perf_process_exit reported",
          { exitCode: 0, reason: "clean-exit" },
        ]),
      ).toBe('[stability] perf_process_exit reported {"exitCode":0,"reason":"clean-exit"}');
    },
  );

  it("redacts secrets, tolerates circular values, and caps the reported message", async () => {
    const formatConsoleErrorArgs = await getPatchedFormatConsoleErrorArgs();
    const circular: Record<string, unknown> = {
      token: "super-secret",
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    };
    circular.self = circular;

    const result = formatConsoleErrorArgs([
      "failed with sk-1234567890abcdefghijklmnopqrstuv",
      circular,
      "x".repeat(4_000),
    ]);

    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result).toContain("<redacted>");
    expect(result).toContain("[Circular]");
    expect(result.length).toBeLessThanOrEqual(2_000);
  });

  it("drops a public prefix without a business message", async () => {
    const formatConsoleErrorArgs = await getPatchedFormatConsoleErrorArgs();

    expect(formatConsoleErrorArgs(["[2026-08-20 17:04:22.265] [pid:25144] [main]"])).toBe("");
  });
});
