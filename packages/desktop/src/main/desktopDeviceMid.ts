import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

export interface EnsureDesktopDeviceMidSyncOptions {
  /** state 文件所在目录，默认 getAppConfigDir()（即 ~/.zcode/v2）。仅测试注入 */
  configDir?: string;
  /** UUID 生成器，默认 createUuid。仅测试注入 */
  createId?: () => string;
}

/**
 * 同步确保设备身份文件（磁盘文件名沿用 telemetry-state.json，与 CLI / 远端 server 共享）里有 deviceMid，并返回该值。
 *
 * 与数仓上报（telemetryCore）共用同一个文件的 `deviceMid` 字段，使 ARMS 与数仓两套
 * device_mid 统一为同一个持久化 UUID。ARMS 侧需要在窗口创建前同步取值（经 preload
 * `--device-id=` 注入），故此处用 node:fs 同步读写。
 *
 * 竞态规避：
 * - 已存在合法 deviceMid 时直接返回、绝不写盘（老用户/二次启动零写入）。
 * - 缺失才写，且读出「完整 state」只补 deviceMid 再写回，避免冲掉 telemetryCore 写的
 *   lastDailyActiveDate / dailyActiveInFlight 等字段。
 * - 原子写（临时文件 + renameSync），避免被并发读方读到半截 JSON。
 *
 * 任何 fs / JSON 异常都不抛：写盘失败仍返回内存中生成的 UUID，下次启动再尝试落盘，
 * 保证窗口创建那一刻 deviceMid 一定有值。
 */
export function ensureDesktopDeviceMidSync(
  options?: EnsureDesktopDeviceMidSyncOptions,
): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readTelemetryStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeTelemetryStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs / JSON 异常兜底：保证一定有返回值，窗口创建不阻塞
    return createId();
  }
}

function readTelemetryStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeTelemetryStateSync(
  stateFile: string,
  state: Record<string, unknown>,
): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
