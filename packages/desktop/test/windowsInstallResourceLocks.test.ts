import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findWindowsProcessesReferencingResourceMarkers,
  isWindowsProcessReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "../src/main/windowsInstallResourceLocks.js";

describe("windows install resource locks", () => {
  it("uses a short release grace after the shared app shutdown barrier", () => {
    expect(WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS).toBe(750);
  });

  it.runIf(process.platform === "win32")(
    "does not report the PowerShell query process as a resource lock",
    async () => {
      // 修复原因：marker 会直接出现在 powershell.exe 的 -Command 参数里；如果脚本排除的是
      // Electron PID 而不是 PowerShell 自身 PID，扫描器必然把自己误报为资源占用进程。
      const uniqueMarker = `zcode-process-scan-self-${process.pid}-${Date.now()}`;

      await expect(
        // CI/开发机的 WMI 在高负载时可能超过生产 3 秒 fail-open 边界；测试只放宽
        // 查询等待，不改变产品更新路径的超时策略。
        findWindowsProcessesReferencingResourceMarkers([uniqueMarker], 10_000),
      ).resolves.toEqual([]);
    },
  );

  it("builds markers for packaged runtime resource directories", () => {
    const resourcesPath = join(
      "C:",
      "Users",
      "demo",
      "AppData",
      "Local",
      "Programs",
      "ZCode",
      "resources",
    );

    expect(resolveWindowsPackagedResourceLockMarkers(resourcesPath)).toEqual([
      join(resourcesPath, "glm"),
      join(resourcesPath, "tools"),
    ]);
  });

  it("matches resource paths regardless of slash direction or case", () => {
    const markers = [
      "C:\\Users\\demo\\AppData\\Local\\Programs\\ZCode\\resources\\glm",
    ];

    expect(
      isWindowsProcessReferencingResourceMarkers(
        {
          pid: 42,
          commandLine:
            '"C:/Users/demo/AppData/Local/Programs/ZCode/ZCode.exe" "C:/Users/demo/AppData/Local/Programs/ZCode/resources/GLM/zcode-agent.exe"',
        },
        markers,
      ),
    ).toBe(true);
  });

  it("does not match unrelated processes", () => {
    const markers = [
      "C:\\Users\\demo\\AppData\\Local\\Programs\\ZCode\\resources\\glm",
    ];

    expect(
      isWindowsProcessReferencingResourceMarkers(
        {
          pid: 108,
          commandLine: '"C:\\Windows\\System32\\notepad.exe"',
          executablePath: "C:\\Windows\\System32\\notepad.exe",
        },
        markers,
      ),
    ).toBe(false);
  });

  it("snapshots packaged resource dirs without throwing on missing dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-resource-snapshot-"));
    try {
      const toolsDir = join(root, "tools");
      mkdirSync(toolsDir, { recursive: true });
      writeFileSync(join(toolsDir, "rg"), "binary", "utf8");

      const snapshot = snapshotWindowsPackagedResources(root);

      expect(snapshot.find((entry) => entry.dir === "tools")).toMatchObject({
        path: toolsDir,
        exists: true,
        entries: ["rg"],
      });
      expect(snapshot.find((entry) => entry.dir === "glm")).toMatchObject({
        exists: false,
        entries: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes packaged resource dirs with writable and missing states", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-resource-probe-"));
    try {
      const glmDir = join(root, "glm");
      mkdirSync(glmDir, { recursive: true });

      const probes = probeWindowsPackagedResourceWritable(root);

      expect(probes.find((entry) => entry.dir === "glm")).toMatchObject({
        path: glmDir,
        exists: true,
        writable: true,
      });
      expect(probes.find((entry) => entry.dir === "tools")).toMatchObject({
        exists: false,
        writable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates only processes still verified against packaged resources", async () => {
    const marker = "C:\\ZCode\\resources\\glm";
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        // 模拟退出屏障前的 Host PID=10 已退出，随后被无关记事本进程复用。
        {
          pid: 10,
          commandLine: '"C:\\Windows\\System32\\notepad.exe"',
        },
        {
          pid: 30,
          commandLine: `"${marker}\\zcode-agent.exe"`,
        },
        {
          pid: 30,
          executablePath: `${marker}\\zcode-agent.exe`,
        },
      ])
      .mockResolvedValueOnce([]);
    const terminate = vi.fn(async (pids: number[]) =>
      pids.map((pid) => ({ pid })),
    );
    const delay = vi.fn(async () => {});

    const result = await runWindowsUpdateProcessCleanup({
      resourceLockMarkers: [marker],
      lockReleaseGraceMs: 300,
      scan,
      terminate,
      delay,
    });

    expect(result.terminationPids).toEqual([30]);
    expect(terminate).toHaveBeenCalledWith([30]);
    expect(delay).toHaveBeenCalledWith(300);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
  });

  it("keeps update cleanup fail-open when scan or taskkill fails", async () => {
    const marker = "C:\\ZCode\\resources\\glm";
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        {
          pid: 10,
          executablePath: `${marker}\\zcode-agent.exe`,
        },
      ])
      .mockRejectedValueOnce(new Error("rescan timeout"));
    const terminate = vi.fn(async () => {
      throw new Error("taskkill failed");
    });

    const result = await runWindowsUpdateProcessCleanup({
      resourceLockMarkers: [marker],
      lockReleaseGraceMs: 300,
      scan,
      terminate,
      delay: async () => {},
    });

    expect(result.terminationPids).toEqual([10]);
    expect(result.remainingLockProcesses).toEqual([]);
    expect(result.errors).toEqual([
      "terminate: taskkill failed",
      "rescan: rescan timeout",
    ]);
  });

  it("does not terminate historical pids when the live scan fails", async () => {
    const terminate = vi.fn(async () => []);

    const result = await runWindowsUpdateProcessCleanup({
      resourceLockMarkers: ["C:\\ZCode\\resources\\glm"],
      lockReleaseGraceMs: 300,
      scan: async () => {
        throw new Error("powershell timeout");
      },
      terminate,
      delay: async () => {},
    });

    expect(result.terminationPids).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
    expect(result.errors).toEqual(["initial-scan: powershell timeout"]);
  });
});
