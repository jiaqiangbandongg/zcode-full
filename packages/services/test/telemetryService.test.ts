import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";

const originalHome = process.env.HOME;
const originalCrypto = globalThis.crypto;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-home-"));
  tempHomes.push(home);
  // Bugfix: paths.ts 会在模块加载时固定默认 dataBaseDir，测试隔离必须显式覆盖。
  setDataBaseDir(home);
  return home;
}

async function waitForCalls(
  mock: ReturnType<typeof vi.fn<typeof fetch>>,
  expectedCalls: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length === expectedCalls) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(mock).toHaveBeenCalledTimes(expectedCalls);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  setDataBaseDir(null);
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
  });
  vi.restoreAllMocks();

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("telemetryCore", () => {
  it.each(["onboarding-user", ""])(
    "onboarding events use common user/device fields for %s",
    async (userId) => {
      const home = makeTempHome();
      const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      const dependencies = { homeDir: home, loadUserId: async () => userId, fetchImpl: fetchMock };
      const context = {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "1280x800",
      };
      const detail = {
        work_direction: "software_data_ai",
        ui_mode: "code",
        workspace_memory_enabled: "false",
        proactive_task_recommendations_enabled: "null",
        claude_code_history_migration_selected: "false",
        exit_action: "close",
        exit_step: "3",
      };
      await createTelemetryCore(dependencies).reportEvent({
        context,
        elementName: "onboarding_expose",
        eventRegion: "app.onboarding",
        eventType: "expose",
        eventText: "",
        eventExtraDetail: {},
      });
      // 重建 Core 模拟进程重新加载，共用持久化设备标识，不由 UI 的 getDeviceId 代替。
      await createTelemetryCore(dependencies).reportEvent({
        context,
        elementName: "onboarding_end",
        eventRegion: "app.onboarding",
        eventType: "ck",
        eventText: "退出引导",
        eventExtraDetail: detail,
      });
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({
        user_id: userId,
        device_mid: expect.any(String),
        element_name: "onboarding_expose",
      });
      expect(bodies[0].device_mid).not.toBe("");
      expect(bodies[1]).toMatchObject({
        user_id: userId,
        device_mid: bodies[0].device_mid,
        element_name: "onboarding_end",
        event_text: "退出引导",
        event_extra_detail: detail,
      });
      expect(bodies[0].event_id).not.toBe(bodies[1].event_id);
    },
  );

  it("exports a telemetry core factory", async () => {
    const loadModule = () => import("../src/telemetry/telemetryCore.js");

    await expect(loadModule()).resolves.toMatchObject({
      createTelemetryCore: expect.any(Function),
    });
  });

  it("uses crypto.randomUUID with the correct receiver by default", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const fakeCrypto = {
      randomUUID(this: unknown) {
        if (this !== fakeCrypto) {
          throw new TypeError('Value of "this" must be fakeCrypto');
        }
        return "default-random-id";
      },
    } as Crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: fakeCrypto,
      configurable: true,
    });

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      appVersion: "0.25.1",
      platform: "darwin",
      osVersion: "13.7.8",
    }) as {
      reportAppLaunch(context: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toMatchObject({
      event_id: "default-random-id",
    });
  });

  it("reports app_launch with the expected request payload", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      loadUserId: async () => "60171703486074334",
      fetchImpl: fetchMock,
      randomUUID: () => "452a978b-d926-4a65-9c07-b04344a307d0",
      appVersion: "0.25.1",
      platform: "darwin",
      osVersion: "13.7.8",
    }) as {
      reportAppLaunch(context: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zcode.z.ai/api/v1/event/report",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toEqual({
      event_id: "452a978b-d926-4a65-9c07-b04344a307d0",
      client_timezone: "Asia/Shanghai",
      client_language: "zh-CN",
      element_name: "app_launch",
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: "60171703486074334",
      screen_resolution: "3024x1964",
      app_version: "0.25.1",
      device_os_category: "macos",
      device_os_version: "13.7.8",
      // device_mid 现已独立于 event_id 生成（见 ensureDeviceMid）；此处因注入的
      // randomUUID 为常量函数，两次调用同值，故与 event_id 恰好相等。
      device_mid: "452a978b-d926-4a65-9c07-b04344a307d0",
      mac_id: "",
      marketing_params: "{}",
    });
  });

  it("attaches marketing_params to every report payload", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      homeDir: home,
      fetchImpl: fetchMock,
      loadMarketingParams: async () => ({
        channel_id: "douyin",
        utm_source: "wechat",
        utm_campaign: "summer_sale_2026",
      }),
      randomUUID: () => "marketing-event-id",
    });
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    await service.reportAppLaunch(context);
    await service.reportEvent({
      context,
      elementName: "button_click",
      eventRegion: "app",
      eventType: "click",
      eventExtraDetail: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        marketing_params:
          '{"channel_id":"douyin","utm_source":"wechat","utm_campaign":"summer_sale_2026"}',
      });
    }
  });

  it("continues reporting without attribution and warns once when attribution loading fails", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const warn = vi.fn();
    const service = createTelemetryCore({
      homeDir: home,
      fetchImpl: fetchMock,
      loadMarketingParams: async () => {
        throw new Error("credential unavailable");
      },
      warn,
      randomUUID: () => "marketing-load-failure-event-id",
    });
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    await service.reportAppLaunch(context);
    await service.reportEvent({
      context,
      elementName: "button_click",
      eventRegion: "app",
      eventType: "click",
      eventExtraDetail: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Telemetry marketing attribution load failed; continuing without attribution",
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        marketing_params: "{}",
      });
    }
  });

  it("uses injected user id loader instead of credential storage details", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const loadUserId = vi.fn(async () => "60171703486074334");
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      loadUserId,
      randomUUID: () => "event-with-loader",
      appVersion: "0.25.1",
      platform: "darwin",
      osVersion: "13.7.8",
    }) as {
      reportAppLaunch(context: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    expect(loadUserId).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toMatchObject({
      user_id: "60171703486074334",
    });
  });

  it("does not write local logs when sending telemetry reports", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const service = createTelemetryCore({
      loadUserId: async () => "60171703486074334",
      fetchImpl: fetchMock,
      randomUUID: () => "telemetry-log-event-id",
      appVersion: "0.25.1",
      platform: "darwin",
      osVersion: "13.7.8",
    }) as {
      reportAppLaunch(context: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("reports custom telemetry events with optional talk and message ids", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      loadUserId: async () => "loaded-user-id",
      fetchImpl: fetchMock,
      randomUUID: () => "custom-event-id",
      appVersion: "0.25.1",
      platform: "darwin",
      osVersion: "13.7.8",
    }) as {
      reportEvent(input: {
        context: {
          clientTimezone: string;
          clientLanguage: string;
          screenResolution: string;
        };
        elementName: string;
        eventRegion: string;
        eventType: string;
        eventExtraDetail: Record<string, string>;
        userId?: string;
        talkId?: string;
        messageId?: string;
      }): Promise<void>;
    };

    await service.reportEvent({
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "3024x1964",
      },
      elementName: "send_btn",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: {
        input_start_time: "1710000000000",
        input_first_char_time: "1710000000100",
        input_send_time: "1710000000200",
      },
      userId: "override-user-id",
      talkId: "task-001",
      messageId: "message-001",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toEqual({
      event_id: "custom-event-id",
      client_timezone: "Asia/Shanghai",
      client_language: "zh-CN",
      element_name: "send_btn",
      event_region: "app",
      event_type: "ck",
      event_text: "",
      event_extra_detail: {
        input_start_time: "1710000000000",
        input_first_char_time: "1710000000100",
        input_send_time: "1710000000200",
      },
      user_id: "override-user-id",
      screen_resolution: "3024x1964",
      app_version: "0.25.1",
      device_os_category: "macos",
      device_os_version: "13.7.8",
      // device_mid 独立生成，此处因常量 mock 与 event_id 恰好相等（见上方说明）
      device_mid: "custom-event-id",
      mac_id: "",
      marketing_params: "{}",
      talk_id: "task-001",
      message_id: "message-001",
    });
  });

  it("reports app_daily_active at most once per local day", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-dau-1",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    await service.reportAppDailyActive(context);
    await service.reportAppDailyActive(context);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const nextDayService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-dau-2",
      now: () => Date.UTC(2026, 3, 3, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    await nextDayService.reportAppDailyActive(context);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, requestInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toMatchObject({
      event_id: "event-dau-2",
      element_name: "app_daily_active",
    });
  });

  it("uses client timezone instead of UTC when deduplicating daily active events", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    const lateNightService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-local-1",
      now: () => Date.UTC(2026, 3, 2, 15, 30, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    await lateNightService.reportAppDailyActive(context);

    const afterMidnightService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-local-2",
      now: () => Date.UTC(2026, 3, 2, 16, 30, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    await afterMidnightService.reportAppDailyActive(context);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, requestInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String((requestInit as RequestInit).body))).toMatchObject({
      event_id: "event-local-2",
      element_name: "app_daily_active",
    });
  });

  it("does not mark daily active as sent when the report endpoint returns non-2xx", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-retry-1",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    await expect(service.reportAppDailyActive(context)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await service.reportAppDailyActive(context);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consoleSpy).not.toHaveBeenCalled();

    await service.reportAppDailyActive(context);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent daily active reports across service instances", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    let releaseFetch: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      await fetchStarted;
      return new Response(null, { status: 204 });
    });
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    const firstService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-concurrent-1",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };
    const secondService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-concurrent-2",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };

    const firstPromise = firstService.reportAppDailyActive(context);
    await Promise.resolve();
    const secondPromise = secondService.reportAppDailyActive(context);

    await waitForCalls(fetchMock, 1);
    releaseFetch?.();

    await Promise.all([firstPromise, secondPromise]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not block app_launch while daily active reporting is in flight", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    let releaseDailyActive: (() => void) | null = null;
    const dailyActiveGate = new Promise<void>((resolve) => {
      releaseDailyActive = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await dailyActiveGate;
        return new Response(null, { status: 204 });
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    const dailyActiveService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-daily-active",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppDailyActive(input: typeof context): Promise<void>;
    };
    const appLaunchService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "event-app-launch",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppLaunch(input: typeof context): Promise<void>;
    };

    const dailyActivePromise = dailyActiveService.reportAppDailyActive(context);
    await waitForCalls(fetchMock, 1);

    const appLaunchPromise = appLaunchService.reportAppLaunch(context);
    await waitForCalls(fetchMock, 2);

    releaseDailyActive?.();
    await Promise.all([dailyActivePromise, appLaunchPromise]);

    const dailyActiveBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const appLaunchBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dailyActiveBody.element_name).toBe("app_daily_active");
    expect(appLaunchBody.element_name).toBe("app_launch");
  });

  it("recovers from a stale telemetry lock file", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const lockFile = join(home, ".zcode", "v2", "telemetry-state.lock");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(lockFile, "", "utf-8");
    const staleAt = new Date(Date.UTC(2026, 3, 1, 0, 0, 0));
    utimesSync(lockFile, staleAt, staleAt);

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "launch-after-stale-lock",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    }) as {
      reportAppLaunch(input: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a fresh telemetry lock owned by a dead process", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const lockFile = join(home, ".zcode", "v2", "telemetry-state.lock");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        createdAt: Date.UTC(2026, 3, 2, 10, 0, 0),
      }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "launch-after-dead-owner-lock",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 1),
    }) as {
      reportAppLaunch(input: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reacquire the state lock for every custom event after device_mid is cached", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const stateDir = join(home, ".zcode", "v2");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "cached-device-mid" }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "cached-event-id",
    }) as {
      reportEvent(input: {
        context: {
          clientTimezone: string;
          clientLanguage: string;
          screenResolution: string;
        };
        elementName: string;
        eventRegion: string;
        eventType: string;
        eventExtraDetail: Record<string, string>;
      }): Promise<void>;
    };
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        service.reportEvent({
          context,
          elementName: "agent_step",
          eventRegion: "app",
          eventType: "agent_trace",
          eventExtraDetail: { index: String(index) },
        }),
      ),
    );

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(500);
  });

  it("persists a stable device_mid across service restarts, decoupled from event_id", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };

    // 每次实例用自增序列，使 event_id 与 device_mid 取到不同值：device_mid 已与首条
    // 事件的 eventId 解耦（独立 randomUUID），仅靠落盘复用保持跨重启稳定。
    function sequentialUuid(prefix: string): () => string {
      let counter = 0;
      return () => `${prefix}-${(counter += 1)}`;
    }

    const firstService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: sequentialUuid("first"),
    }) as {
      reportAppLaunch(input: typeof context): Promise<void>;
    };

    await firstService.reportAppLaunch(context);

    const secondService = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: sequentialUuid("second"),
    }) as {
      reportAppLaunch(input: typeof context): Promise<void>;
    };

    await secondService.reportAppLaunch(context);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));

    // 首次：eventId=first-1，device_mid 是另一次独立调用 first-2（已解耦，不再相等）
    expect(firstBody.event_id).toBe("first-1");
    expect(firstBody.device_mid).toBe("first-2");
    expect(firstBody.device_mid).not.toBe(firstBody.event_id);
    // 重启：eventId 重新生成 second-1，device_mid 复用落盘值 first-2（跨重启稳定）
    expect(secondBody.event_id).toBe("second-1");
    expect(secondBody.device_mid).toBe("first-2");

    const telemetryStateFile = join(home, ".zcode", "v2", "telemetry-state.json");
    const telemetryState = JSON.parse(readFileSync(telemetryStateFile, "utf-8")) as {
      deviceMid: string;
    };
    expect(telemetryState.deviceMid).toBe("first-2");
  });

  it("keeps an existing persisted device_mid (back-compat with legacy event-id values)", async () => {
    const home = makeTempHome();
    process.env.HOME = home;

    // 老版本把首条事件的 eventId 当作 device_mid 落盘；新逻辑必须原样复用，不得突变
    const stateDir = join(home, ".zcode", "v2");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "legacy-event-id-from-old-version" }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "fresh-event-id",
    }) as {
      reportAppLaunch(input: {
        clientTimezone: string;
        clientLanguage: string;
        screenResolution: string;
      }): Promise<void>;
    };

    await service.reportAppLaunch({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.device_mid).toBe("legacy-event-id-from-old-version");
    expect(body.event_id).toBe("fresh-event-id");
  });
});
