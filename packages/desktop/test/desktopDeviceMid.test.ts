import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDesktopDeviceMidSync } from "../src/main/desktopDeviceMid.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-device-mid-"));
  tempDirs.push(dir);
  return dir;
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "telemetry-state.json"), "utf-8"));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ensureDesktopDeviceMidSync", () => {
  it("复用已存在的 deviceMid，且不改写文件", () => {
    const dir = makeTempDir();
    const stateFile = join(dir, "telemetry-state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({ deviceMid: "existing-uuid", lastDailyActiveDate: "2026-01-01" }),
      "utf-8",
    );
    const mtimeBefore = statSync(stateFile).mtimeMs;

    const result = ensureDesktopDeviceMidSync({
      configDir: dir,
      createId: () => "should-not-be-used",
    });

    expect(result).toBe("existing-uuid");
    // 既有字段保持原样，且未触发写盘
    const state = readState(dir);
    expect(state.deviceMid).toBe("existing-uuid");
    expect(state.lastDailyActiveDate).toBe("2026-01-01");
    expect(statSync(stateFile).mtimeMs).toBe(mtimeBefore);
  });

  it("缺失时生成 UUID 并落盘", () => {
    const dir = makeTempDir();

    const result = ensureDesktopDeviceMidSync({
      configDir: dir,
      createId: () => "new-uuid",
    });

    expect(result).toBe("new-uuid");
    expect(readState(dir).deviceMid).toBe("new-uuid");
  });

  it("补写 deviceMid 时保留同文件其他字段", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "telemetry-state.json"),
      JSON.stringify({ lastDailyActiveDate: "2026-06-23", dailyActiveInFlight: { date: "x", startedAt: 1 } }),
      "utf-8",
    );

    ensureDesktopDeviceMidSync({ configDir: dir, createId: () => "added-uuid" });

    const state = readState(dir);
    expect(state.deviceMid).toBe("added-uuid");
    expect(state.lastDailyActiveDate).toBe("2026-06-23");
    expect(state.dailyActiveInFlight).toEqual({ date: "x", startedAt: 1 });
  });

  it("与数仓侧（telemetryCore）读到同一个 device_mid", async () => {
    const dir = makeTempDir();
    const generated = ensureDesktopDeviceMidSync({
      configDir: dir,
      createId: () => "shared-device-uuid",
    });

    // telemetryCore 用 homeDir 定位 state 文件：{homeDir}/.zcode/v2/telemetry-state.json
    // 让该路径正好等于本测试的 configDir，验证两侧读同一字段。
    const home = makeTempDir();
    const sharedDir = join(home, ".zcode", "v2");
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      join(sharedDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: generated }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("@zcode/services/node");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = createTelemetryCore({
      homeDir: home,
      fetchImpl: fetchMock,
      randomUUID: () => "unrelated-event-id",
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
    expect(body.device_mid).toBe("shared-device-uuid");
  });

  it("JSON 损坏时视作缺失，生成新 UUID 不抛", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "telemetry-state.json"), "{ not valid json", "utf-8");

    const result = ensureDesktopDeviceMidSync({ configDir: dir, createId: () => "recovered-uuid" });

    expect(result).toBe("recovered-uuid");
    expect(readState(dir).deviceMid).toBe("recovered-uuid");
  });

  it("写盘失败时不抛、仍返回生成的 UUID", () => {
    const dir = makeTempDir();
    // 指向一个无法创建的路径（已存在的文件当目录），迫使 mkdir/write 失败
    const filePath = join(dir, "blocker");
    writeFileSync(filePath, "x", "utf-8");

    const result = ensureDesktopDeviceMidSync({
      configDir: join(filePath, "nested"),
      createId: () => "fallback-uuid",
    });

    expect(result).toBe("fallback-uuid");
  });
});
