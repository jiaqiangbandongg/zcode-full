import { describe, expect, it, vi } from "vitest";
import {
  createCloseToTrayCapabilityMonitor,
  detectDesktopCloseToTrayCapability,
  isGnomeLikeDesktop,
  parseStatusNotifierOwnerOutput,
  resolveCloseToTrayBootstrapValue,
  resolveCloseToTrayRuntimeValue,
  resolveCloseToTraySupported,
  type TraySupportCommandExecutor,
} from "../src/main/desktopTraySupport.js";

describe("parseStatusNotifierOwnerOutput", () => {
  it("parses gdbus / busctl / qdbus outputs", () => {
    expect(parseStatusNotifierOwnerOutput("(true,)")).toBe(true);
    expect(parseStatusNotifierOwnerOutput("(false,)")).toBe(false);
    expect(parseStatusNotifierOwnerOutput('b "true"')).toBe(true);
    expect(parseStatusNotifierOwnerOutput('b "false"')).toBe(false);
    // CR-01：busctl 的真实布尔输出不带引号（字符串类型才带引号）；带引号变体一并接受。
    expect(parseStatusNotifierOwnerOutput("b true")).toBe(true);
    expect(parseStatusNotifierOwnerOutput("b false")).toBe(false);
    expect(parseStatusNotifierOwnerOutput("true")).toBe(true);
    expect(parseStatusNotifierOwnerOutput("false")).toBe(false);
    expect(parseStatusNotifierOwnerOutput("true\n")).toBe(true);
  });

  it("returns null for unrecognized output", () => {
    expect(parseStatusNotifierOwnerOutput("")).toBeNull();
    expect(parseStatusNotifierOwnerOutput("Error: unknown")).toBeNull();
  });
});

describe("isGnomeLikeDesktop", () => {
  it("detects gnome variants case-insensitively", () => {
    expect(isGnomeLikeDesktop({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(true);
    expect(isGnomeLikeDesktop({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
    expect(isGnomeLikeDesktop({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
    expect(isGnomeLikeDesktop({ XDG_SESSION_DESKTOP: "gnome-xorg" })).toBe(false);
    expect(isGnomeLikeDesktop({})).toBe(false);
  });
});

describe("detectDesktopCloseToTrayCapability", () => {
  it("short-circuits to supported on non-linux platforms", async () => {
    const execute = vi.fn<TraySupportCommandExecutor>();
    await expect(
      detectDesktopCloseToTrayCapability({ platform: "win32", execute }),
    ).resolves.toEqual({ supported: true, gnomeLikeWithoutTray: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns supported when gdbus reports watcher owner", async () => {
    const execute = vi.fn<TraySupportCommandExecutor>().mockResolvedValue({ stdout: "(true,)" });
    await expect(
      detectDesktopCloseToTrayCapability({ platform: "linux", execute }),
    ).resolves.toEqual({ supported: true, gnomeLikeWithoutTray: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe("gdbus");
  });

  it("falls back to busctl when gdbus is missing", async () => {
    const execute = vi
      .fn<TraySupportCommandExecutor>()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ stdout: 'b "true"' });
    await expect(
      detectDesktopCloseToTrayCapability({ platform: "linux", execute }),
    ).resolves.toEqual({ supported: true, gnomeLikeWithoutTray: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toBe("busctl");
  });

  it("falls back to qdbus and parses plain output", async () => {
    const execute = vi
      .fn<TraySupportCommandExecutor>()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ stdout: "garbage" })
      .mockResolvedValueOnce({ stdout: "false" });
    await expect(
      detectDesktopCloseToTrayCapability({ platform: "linux", execute }),
    ).resolves.toEqual({ supported: false, gnomeLikeWithoutTray: false });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]?.[0]).toBe("qdbus");
  });

  it("marks gnomeLikeWithoutTray on GNOME without watcher", async () => {
    const execute = vi.fn<TraySupportCommandExecutor>().mockResolvedValue({ stdout: "(false,)" });
    await expect(
      detectDesktopCloseToTrayCapability({
        platform: "linux",
        env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        execute,
      }),
    ).resolves.toEqual({ supported: false, gnomeLikeWithoutTray: true });
  });

  it("treats all-probe-failure as unsupported (safe default)", async () => {
    const execute = vi.fn<TraySupportCommandExecutor>().mockRejectedValue(new Error("missing"));
    await expect(
      detectDesktopCloseToTrayCapability({
        platform: "linux",
        env: { XDG_CURRENT_DESKTOP: "KDE" },
        execute,
      }),
    ).resolves.toEqual({ supported: false, gnomeLikeWithoutTray: false });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("passes timeout to the executor", async () => {
    const execute = vi.fn<TraySupportCommandExecutor>().mockResolvedValue({ stdout: "(true,)" });
    await detectDesktopCloseToTrayCapability({
      platform: "linux",
      execute,
      commandTimeoutMs: 250,
    });
    expect(execute.mock.calls[0]?.[2]).toBe(250);
  });
});

describe("createCloseToTrayCapabilityMonitor", () => {
  it("returns null before first refresh completes", () => {
    const monitor = createCloseToTrayCapabilityMonitor({ platform: "linux" });
    expect(monitor.getSync()).toBeNull();
  });

  it("caches refresh result for getSync", async () => {
    let sequence = 0;
    const monitor = createCloseToTrayCapabilityMonitor({
      platform: "linux",
      execute: vi.fn<TraySupportCommandExecutor>().mockImplementation(async () => {
        sequence += 1;
        return { stdout: sequence === 1 ? "(true,)" : "(false,)" };
      }),
    });
    await monitor.refresh(true);
    expect(monitor.getSync()).toEqual({ supported: true, gnomeLikeWithoutTray: false });
  });

  it("serves cached result within stale window and re-probes after it", async () => {
    let clock = 0;
    let sequence = 0;
    const execute = vi.fn<TraySupportCommandExecutor>().mockImplementation(async () => {
      sequence += 1;
      return { stdout: sequence === 1 ? "(true,)" : "(false,)" };
    });
    const monitor = createCloseToTrayCapabilityMonitor({
      platform: "linux",
      execute,
      now: () => clock,
      staleMs: 10_000,
    });

    await monitor.refresh(true);
    expect(execute).toHaveBeenCalledTimes(1);

    clock += 5_000;
    await monitor.refresh();
    expect(execute).toHaveBeenCalledTimes(1);

    clock += 6_000;
    await monitor.refresh();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(monitor.getSync()).toEqual({ supported: false, gnomeLikeWithoutTray: false });
  });

  it("concurrent refreshes share one probe", async () => {
    let resolveProbe: ((value: { stdout: string }) => void) | null = null;
    const execute = vi.fn<TraySupportCommandExecutor>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const monitor = createCloseToTrayCapabilityMonitor({ platform: "linux", execute });
    const first = monitor.refresh(true);
    const second = monitor.refresh(true);
    resolveProbe?.({ stdout: "(true,)" });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCloseToTrayBootstrapValue", () => {
  it("keeps windows fallback default true and never migrates", () => {
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "win32",
        stored: undefined,
        linuxMigrationInitialized: undefined,
      }),
    ).toEqual({ value: true, needsLinuxMigration: false });
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "win32",
        stored: false,
        linuxMigrationInitialized: undefined,
      }),
    ).toEqual({ value: false, needsLinuxMigration: false });
  });

  it("forces linux default off on first launch and requests migration", () => {
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "linux",
        stored: true,
        linuxMigrationInitialized: undefined,
      }),
    ).toEqual({ value: false, needsLinuxMigration: true });
  });

  it("respects explicit linux choice after migration initialized", () => {
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "linux",
        stored: true,
        linuxMigrationInitialized: true,
      }),
    ).toEqual({ value: true, needsLinuxMigration: false });
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "linux",
        stored: false,
        linuxMigrationInitialized: true,
      }),
    ).toEqual({ value: false, needsLinuxMigration: false });
    expect(
      resolveCloseToTrayBootstrapValue({
        platform: "linux",
        stored: undefined,
        linuxMigrationInitialized: true,
      }),
    ).toEqual({ value: false, needsLinuxMigration: false });
  });
});

describe("resolveCloseToTraySupported", () => {
  it("win32 只依赖托盘实例创建结果", () => {
    expect(
      resolveCloseToTraySupported({
        platform: "win32",
        desktopTrayReady: true,
        capabilitySupported: undefined,
      }),
    ).toBe(true);
    // CR-01：Windows 托盘创建失败时同样不得隐藏（入口不存在即失联），即使设置开启。
    expect(
      resolveCloseToTraySupported({
        platform: "win32",
        desktopTrayReady: false,
        capabilitySupported: true,
      }),
    ).toBe(false);
  });

  it("linux 要求托盘实例与 DBus 能力同时成立", () => {
    expect(
      resolveCloseToTraySupported({
        platform: "linux",
        desktopTrayReady: true,
        capabilitySupported: true,
      }),
    ).toBe(true);
    // DBus 可用但 Tray 创建失败（图标缺失/会话未就绪）——不得隐藏。
    expect(
      resolveCloseToTraySupported({
        platform: "linux",
        desktopTrayReady: false,
        capabilitySupported: true,
      }),
    ).toBe(false);
    // 托盘在但 watcher 掉线/缓存为空——按不可用安全默认。
    expect(
      resolveCloseToTraySupported({
        platform: "linux",
        desktopTrayReady: true,
        capabilitySupported: false,
      }),
    ).toBe(false);
    expect(
      resolveCloseToTraySupported({
        platform: "linux",
        desktopTrayReady: true,
        capabilitySupported: undefined,
      }),
    ).toBe(false);
  });

  it("其它平台一律不可隐藏", () => {
    expect(
      resolveCloseToTraySupported({
        platform: "darwin",
        desktopTrayReady: true,
        capabilitySupported: true,
      }),
    ).toBe(false);
  });
});

describe("resolveCloseToTrayRuntimeValue", () => {
  it("迁移持久化成功时采用归位值 false", () => {
    expect(
      resolveCloseToTrayRuntimeValue({
        platform: "linux",
        stored: true,
        linuxMigrationInitialized: undefined,
        migrationPersisted: true,
      }),
    ).toBe(false);
  });

  it("迁移持久化失败时回退文件值，维持文件为唯一可信来源（CR-02）", () => {
    expect(
      resolveCloseToTrayRuntimeValue({
        platform: "linux",
        stored: true,
        linuxMigrationInitialized: undefined,
        migrationPersisted: false,
      }),
    ).toBe(true);
    expect(
      resolveCloseToTrayRuntimeValue({
        platform: "linux",
        stored: undefined,
        linuxMigrationInitialized: undefined,
        migrationPersisted: false,
      }),
    ).toBe(true);
  });

  it("无迁移需求的路径不受持久化标志影响", () => {
    expect(
      resolveCloseToTrayRuntimeValue({
        platform: "linux",
        stored: false,
        linuxMigrationInitialized: true,
        migrationPersisted: false,
      }),
    ).toBe(false);
    expect(
      resolveCloseToTrayRuntimeValue({
        platform: "win32",
        stored: undefined,
        linuxMigrationInitialized: undefined,
        migrationPersisted: false,
      }),
    ).toBe(true);
  });
});
