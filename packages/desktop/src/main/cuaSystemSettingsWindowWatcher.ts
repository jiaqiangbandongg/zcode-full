/**
 * 系统设置窗口位置的数据源：spawn 常驻的 `zcode-window-bounds` 并读它的 stdout。
 *
 * 设计约束全部来自「吸附是观感增强、不是可用性前提」这一条：
 *   - 二进制缺失、spawn 失败、进程崩溃、输出损坏 —— 全部表现为 `latest() === null`，由
 *     positioner 走 fail-open 分支把面板放到屏幕底部。**任何路径都不得抛错**，否则会把一个
 *     纯装饰问题升级成"授权引导打不开"。
 *   - 进程死后立刻停止报告陈旧位置：否则面板会永久钉在设置页最后出现的地方，比放在屏幕底部
 *     更糟（用户会以为面板卡死了）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Rect } from "./cuaPermissionPanelPositioner.js";

export interface SystemSettingsWindowWatcher {
  start(): void;
  stop(): void;
  /** 最近一次成功解析到的系统设置主窗口 bounds；拿不到时为 null。 */
  latest(): Rect | null;
}

export interface CreateSystemSettingsWindowWatcherOptions {
  binaryPath: string;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: (binaryPath: string, args: string[]) => ChildProcess;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

const DEFAULT_INTERVAL_MS = 150;

interface RawWindow {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  layer?: unknown;
}

function toRect(raw: RawWindow): Rect | null {
  const { x, y, w, h, layer } = raw;
  // 只认 layer 0：设置页会带出 layer > 0 的辅助层（工具提示、弹出选择器），
  // 吸附到它们会把面板扔到屏幕角落。
  if (layer !== 0) return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function parseLine(line: string): Rect | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  // 取面积最大的 layer-0 窗口，而不是 z-order 上的第一个。
  //
  // 拖拽落地后系统设置会弹一个模态提示（"…may not be able to record
  // the contents of your screen until it is quit…"），它同属 System Settings 进程、同样是
  // layer 0，而且 z-order 比主窗更靠前。取第一个会让浮窗吸附到提示框底部，把自己塞到它下面。
  // 设置页主窗总是这些窗口里最大的那个。
  let best: Rect | null = null;
  let bestArea = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const rect = toRect(entry as RawWindow);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

export function createSystemSettingsWindowWatcher(
  options: CreateSystemSettingsWindowWatcherOptions,
): SystemSettingsWindowWatcher {
  const platform = options.platform ?? process.platform;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const spawnProcess =
    options.spawnProcess ?? ((path, args) => spawn(path, args, { stdio: "pipe" }));

  let child: ChildProcess | null = null;
  let current: Rect | null = null;
  // stdout 的分块与行边界无关，必须自己攒行；按 chunk 直接 parse 会在真机上间歇性失败。
  let buffer = "";

  function reset(): void {
    current = null;
    buffer = "";
  }

  return {
    start(): void {
      if (platform !== "darwin" || child) return;
      try {
        child = spawnProcess(options.binaryPath, [String(intervalMs)]);
      } catch (error) {
        // 二进制未随包/无执行权限：fail-open，面板照样能用，只是不吸附。
        options.logger.warn(
          "[cua-permission-panel] window bounds helper unavailable; panel will not anchor",
          error instanceof Error ? error.message : String(error),
        );
        child = null;
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = buffer.split("\n");
        // 最后一段可能是不完整行，留在 buffer 里等下一个 chunk
        buffer = lines.pop() ?? "";
        // 只取最后一条完整行：中间的都是过期位置
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (line.trim().length === 0) continue;
          current = parseLine(line);
          return;
        }
      });

      child.on("error", (error: Error) => {
        options.logger.warn("[cua-permission-panel] window bounds helper error", error.message);
        reset();
        child = null;
      });

      child.on("exit", (code: number | null) => {
        // 进程死了就别再报陈旧位置 —— 面板钉死在旧位置比退回屏幕底部更让人困惑。
        if (code !== 0 && code !== null) {
          options.logger.warn("[cua-permission-panel] window bounds helper exited", code);
        }
        reset();
        child = null;
      });
    },

    stop(): void {
      if (child) {
        try {
          child.kill();
        } catch {
          // 已退出，忽略
        }
        child = null;
      }
      reset();
    },

    latest(): Rect | null {
      return current;
    },
  };
}
