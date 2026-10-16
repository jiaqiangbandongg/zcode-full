import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { buildZCodeSourceHeaders } from "../src/providers/sourceHeaders.js";
import { createTelemetryCore, ensureTelemetryDeviceMid } from "../src/telemetry/telemetryCore.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("ensureTelemetryDeviceMid", () => {
  const tempDirs: string[] = [];

  function createIsolatedDataBaseDir(): { dataBaseDir: string; stateFile: string } {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-remote-device-mid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    return {
      dataBaseDir,
      stateFile: join(dataBaseDir, ".zcode", "v2", "telemetry-state.json"),
    };
  }

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("远端主机没有 telemetry-state.json 时，确保后 ZCode 来源头才带上同一个 X-Device-Mid", async () => {
    // 复现远端事故前提：全新主机没有任何进程写过 state 文件，来源头缺 X-Device-Mid。
    const { stateFile } = createIsolatedDataBaseDir();
    expect(existsSync(stateFile)).toBe(false);
    expect(buildZCodeSourceHeaders()["X-Device-Mid"]).toBeUndefined();

    const deviceMid = await ensureTelemetryDeviceMid();

    expect(deviceMid).toMatch(UUID_PATTERN);
    expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({ deviceMid });
    // 与 NodeApiClient 实际注入来源头的同一读取路径必须拿到同一个值。
    expect(buildZCodeSourceHeaders()["X-Device-Mid"]).toBe(deviceMid);
  });

  it("已有 deviceMid 时复用现值，不改写 state 文件里的其他字段", async () => {
    const { stateFile } = createIsolatedDataBaseDir();
    mkdirSync(join(stateFile, ".."), { recursive: true });
    const existing = JSON.stringify(
      { deviceMid: "existing-device-mid", lastDailyActiveDate: "2026-09-12" },
      null,
      2,
    );
    writeFileSync(stateFile, existing, "utf-8");

    await expect(ensureTelemetryDeviceMid()).resolves.toBe("existing-device-mid");

    expect(readFileSync(stateFile, "utf-8")).toBe(existing);
  });

  it("并发确保与 telemetry 上报共享同一个 deviceMid，不会生成第二个身份", async () => {
    const { dataBaseDir, stateFile } = createIsolatedDataBaseDir();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const core = createTelemetryCore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: dataBaseDir,
    });

    const [first, second] = await Promise.all([
      ensureTelemetryDeviceMid({ homeDir: dataBaseDir }),
      ensureTelemetryDeviceMid({ homeDir: dataBaseDir }),
    ]);
    await core.reportAppLaunch({
      clientLanguage: "zh-CN",
      clientTimezone: "Asia/Shanghai",
      screenResolution: "1x1",
    });

    expect(first).toBe(second);
    expect(JSON.parse(readFileSync(stateFile, "utf-8")).deviceMid).toBe(first);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      device_mid?: string;
    };
    expect(body.device_mid).toBe(first);
  });
});
