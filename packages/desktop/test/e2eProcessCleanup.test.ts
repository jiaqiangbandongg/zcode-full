import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  buildE2ERunIdArg,
  buildWindowsTaskkillArgs,
  collectProcessTreeByRootPids,
  collectE2EProcessTreePids,
  collectWindowsE2EProcessTreePids,
  createWindowsE2EHomeMarkerArg,
  listE2EProcessTreePids,
  listSystemProcesses,
} from "./e2e/helpers/e2e-process-cleanup.js";

const CURRENT_HOME = "C:\\e2e\\shards\\current";
const CURRENT_HOME_MARKER = createWindowsE2EHomeMarkerArg(CURRENT_HOME);

function toProcessJson(rows: Array<{ command: unknown; parentPid: unknown; pid: unknown }>) {
  return JSON.stringify(
    rows.map((row) => ({
      CommandLine: row.command,
      ParentProcessId: row.parentPid,
      ProcessId: row.pid,
    })),
  );
}

describe("desktop e2e process cleanup", () => {
  it("combines one worker process tree into a single taskkill invocation", () => {
    expect(buildWindowsTaskkillArgs([12, 11, 12, 10])).toEqual([
      "/PID",
      "12",
      "/PID",
      "11",
      "/PID",
      "10",
      "/T",
      "/F",
    ]);
  });

  it("passes both run and HOME identity markers through Electron appArgs", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(CURRENT_HOME_MARKER).toBe(`--zcode-e2e-home=${CURRENT_HOME}`);
    expect(wdioSource).toMatch(
      /appArgs:\s*\[[\s\S]*?buildE2ERunIdArg\(E2E_RUN_ID\)[\s\S]*?createWindowsE2EHomeMarkerArg\(E2E_HOME_DIR\)[\s\S]*?\]/u,
    );
  });

  it("stages and launches an immutable app output under the current run cache", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    // Bugfix: dev watcher 会清空共享 out；Electron 必须从 runId 隔离副本启动。
    expect(wdioSource).toMatch(/const E2E_APP_OUTPUT_DIR = resolve\(E2E_RUN_CACHE_DIR, "app"\)/u);
    expect(wdioSource).toMatch(
      /await stageE2EAppOutput\(DESKTOP_BUILD_OUTPUT_DIR, E2E_APP_OUTPUT_DIR\)/u,
    );
    expect(wdioSource).toMatch(/`--app=\$\{E2E_APP_ENTRY_POINT\}`/u);
    expect(wdioSource).not.toMatch(/`--app=\$\{DESKTOP_BUILD_ENTRY_POINT\}`/u);
  });

  it("lets ChromeDriver close the renderer before Electron app.quit", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

    expect(wdioSource).toMatch(/appWindow\.once\("closed", requestQuitAfterDriverClose\)/u);
    expect(wdioSource).toMatch(/async after[\s\S]*?await armCurrentElectronAppQuit\("after"\)/u);
    expect(wdioSource).not.toMatch(/async after[\s\S]*?await quitCurrentElectronApp\("after"\)/u);
    expect(mainSource).toMatch(/win\.once\("closed", exitAfterLastWindowClosed\)/u);
    expect(mainSource).toMatch(
      /const exitAfterLastWindowClosed[\s\S]*?exitPreparedApp\("all-windows-closed-after-preparation"\)/u,
    );
    expect(mainSource).toMatch(
      /process\.env\.ZCODE_E2E_RUN_ID\?\.trim\(\)[\s\S]*?spawn\("taskkill"[\s\S]*?spawn\("kill", \["-9", String\(process\.pid\)\]/u,
    );
  });

  it("waits for each window Host once and keeps update install on the strict policy", () => {
    const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

    // R1 后 remote session 是窗口 Host 内资源；manager 只清理请求关联，真正的连接释放由
    // windowHostProcessMap 中唯一 Host 的 shutdown barrier 完成。
    expect(mainSource).toMatch(
      /async function prepareAppQuit[\s\S]*?remoteSessionManager\.disposeAllAndWaitForAppShutdown\(reason\)/u,
    );
    expect(mainSource).toMatch(
      /async function prepareAppQuit[\s\S]*?stopRemoteUsageArmsPeriodicSampling\(\)[\s\S]*?remoteSessionManager\.disposeAllAndWaitForAppShutdown\(reason\)/u,
    );
    expect(mainSource).toMatch(
      /async function prepareAppQuit[\s\S]*?stopDesktopResourceTelemetry\(\{ flushPendingWindows: true \}\)/u,
    );
    // 修复原因：更新安装现在复用唯一的 prepareAppQuit 屏障并显式选择严格预算；旧断言要求
    // Windows 专项资源扫描再次等待 Remote Host，已经与“只执行一次 Host 屏障”的事实冲突。
    expect(mainSource).toMatch(
      /prepareAppQuit\("auto-update quitAndInstall", "update-install"\)[\s\S]*?prepareWindowsProcessesForUpdateInstall\(\)/u,
    );
    expect(mainSource).toMatch(
      /async function prepareAppQuit[\s\S]*?selectAppShutdownPolicy[\s\S]*?if \(hasPreparedAppQuit\)[\s\S]*?if \(appQuitPreparationInFlight\)/u,
    );
    expect(mainSource).toMatch(
      /createRemoteWorkspaceSessionManager\(\{[\s\S]*?windowHostProcessMap[\s\S]*?const hostProcesses = \[[\s\S]*?windowHostProcessMap\.values\(\)[\s\S]*?disposeHostProcessAndWait\([\s\S]*?activeAppShutdownPolicy\.forceKillDelayMs[\s\S]*?activeAppShutdownPolicy\.waitTimeoutMs/u,
    );
    expect(mainSource).not.toMatch(/resolveRemoteHostShutdownPolicy/u);
    expect(mainSource).toMatch(
      /const cronSchedulerToDispose = cronScheduler[\s\S]*?appQuitPreparationInFlight = Promise\.all\(\[[\s\S]*?cronSchedulerToDispose\?\.dispose\(\)[\s\S]*?remoteSessionManager\.disposeAllAndWaitForAppShutdown/u,
    );
    // Bug 原因：退出屏障结束后窗口 close 还会启动异步设置写入，app.exit 可能留下锁。
    // 窗口尺寸只在 resize/maximize/unmaximize 阶段保存，退出屏障不得新建该写入。
    expect(mainSource).not.toMatch(
      /appQuitPreparationInFlight = Promise\.all\(\[[\s\S]*?desktopWindowSizePersistence\?\.flush\(\)/u,
    );
    // /event/report 的内存内投递必须与 Host/Cron 清理并行进入同一个退出屏障，且等待有界。
    expect(mainSource).toMatch(
      /appQuitPreparationInFlight = Promise\.all\(\[[\s\S]*?appTelemetryCore\.flushPendingReports\(\{ timeoutMs: 2_000 \}\)/u,
    );
    // Bug 根因：Browser tab 已改为进程内 stateless residency，完整退出不再恢复 tab。
    // 退出屏障只等待真实的 Host/Cron owner；继续要求 recovery idle 会让测试绑定已删除的恢复链路。
    expect(mainSource).not.toMatch(/browserGuestManager\.whenRecoveryIdle\(\)/u);
    expect(mainSource).toMatch(
      /async function prepareAppQuit[\s\S]*?browserScreenshotSurfaceCoordinator\.dispose\(\)/u,
    );
  });

  it("forces the Host to exit after its parent IPC disconnects", () => {
    const hostSource = readFileSync(new URL("../src/host/index.ts", import.meta.url), "utf8");

    expect(hostSource).toMatch(
      /process\.once\("disconnect"[\s\S]*?disposeHostResources\("disconnect"\)\.finally\(\(\) => process\.exit\(1\)\)/u,
    );
  });

  it("Host waits for the remote stdio close handshake", () => {
    const hostSource = readFileSync(new URL("../src/host/index.ts", import.meta.url), "utf8");

    expect(hostSource).toMatch(
      /async function disposeHostRemoteConnection[\s\S]*?connection\.disposeAndWait\(\{ timeoutMs: 5_000 \}\)[\s\S]*?name: "remote-registry-dispose"[\s\S]*?timeoutMs: 6_000/u,
    );
  });

  it("collects only the current run root and its child process tree", () => {
    const sharedEntryPoint = "/repo/packages/desktop/out/main/index.js";
    const processes = [
      {
        command: `Electron --app=${sharedEntryPoint} --no-sandbox ${buildE2ERunIdArg("run-a")}`,
        pid: 10,
        ppid: 1,
      },
      { command: "node host-process", pid: 11, ppid: 10 },
      { command: "node zcode-agent", pid: 12, ppid: 11 },
      {
        command: `Electron --app=${sharedEntryPoint} --no-sandbox ${buildE2ERunIdArg("run-b")}`,
        pid: 20,
        ppid: 1,
      },
      { command: "node other-host-process", pid: 21, ppid: 20 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 999,
        homeDir: "/tmp/zcode-e2e-run-a",
        runId: "run-a",
      }),
    ).toEqual([12, 11, 10]);
  });

  it("collects an explicitly anchored Electron main tree without command markers", () => {
    const processes = [
      { command: "Electron", pid: 10, ppid: 1 },
      { command: "Electron Helper (Renderer)", pid: 11, ppid: 10 },
      { command: "node host-process", pid: 12, ppid: 10 },
      { command: "node zcode-agent", pid: 13, ppid: 12 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 999,
        homeDir: "/tmp/zcode-e2e-run-a",
        rootPids: [10],
        runId: "run-a",
      }),
    ).toEqual([13, 12, 11, 10]);
  });

  it("recovers markerless ChromeDriver and Electron ancestors from a marked renderer", () => {
    const currentHome = "/tmp/zcode-e2e-run-a";
    const processes = [
      { command: "node wdio.conf.ts", pid: 9, ppid: 1 },
      { command: "chromedriver --port=55089", pid: 10, ppid: 9 },
      { command: "ZCode E2E", pid: 11, ppid: 10 },
      {
        command: `Electron Helper (Renderer) --user-data-dir=/repo/.e2e-cache/run-a/chromium-profiles/0-51 --config=${currentHome}/.zcode/config.json`,
        pid: 12,
        ppid: 11,
      },
      { command: "node host-process", pid: 13, ppid: 11 },
      {
        command: "Electron Helper --user-data-dir=/repo/.e2e-cache/run-b/chromium-profiles/0-4",
        pid: 22,
        ppid: 21,
      },
      { command: "ZCode E2E", pid: 21, ppid: 20 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 9,
        homeDir: currentHome,
        runId: "run-a",
      }),
    ).toEqual([13, 12, 11, 10]);
  });

  it("keeps ChromeDriver out of the per-session reload exit barrier", () => {
    const currentHome = "/tmp/zcode-e2e-run-a";
    const processes = [
      { command: "node wdio.conf.ts", pid: 9, ppid: 1 },
      { command: "chromedriver --port=55089", pid: 10, ppid: 9 },
      { command: "ZCode E2E", pid: 11, ppid: 10 },
      {
        command: `Electron Helper (Renderer) --config=${currentHome}/.zcode/config.json`,
        pid: 12,
        ppid: 11,
      },
      { command: "node host-process", pid: 13, ppid: 11 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 9,
        homeDir: currentHome,
        includeChromeDriverAncestors: false,
        runId: "run-a",
      }),
    ).toEqual([13, 12, 11]);
  });

  it("does not climb from an E2E driver into an unrelated terminal process tree", () => {
    const processes = [
      { command: "Terminal.app", pid: 5, ppid: 1 },
      { command: "zsh", pid: 6, ppid: 5 },
      { command: "node old-wdio-worker.js", pid: 7, ppid: 6 },
      { command: "chromedriver --port=55089", pid: 10, ppid: 7 },
      { command: "ZCode E2E", pid: 11, ppid: 10 },
      {
        command:
          "Electron Helper --user-data-dir=/repo/.e2e-cache/run-a/chromium-profiles/0-51 --config=/tmp/zcode-e2e-run-a/.zcode/config.json",
        pid: 12,
        ppid: 11,
      },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 99,
        homeDir: "/tmp/zcode-e2e-run-a",
        runId: "run-a",
      }),
    ).toEqual([12, 11, 10]);
  });

  it("uses the shared run identity scanner for POSIX process trees", () => {
    const runCommand = vi.fn(() =>
      [
        `10 1 Electron ${buildE2ERunIdArg("run-a")}`,
        "11 10 node host-process",
        "12 11 node zcode-agent",
      ].join("\n"),
    );

    expect(
      listE2EProcessTreePids(
        { currentPid: 999, homeDir: "/tmp/zcode-e2e-run-a", runId: "run-a" },
        { platform: "linux", runCommand },
      ),
    ).toEqual([12, 11, 10]);
    expect(runCommand).toHaveBeenCalledWith("ps", ["-axo", "pid=,ppid=,command="]);
  });

  it("lists and scopes a read-only system process snapshot by explicit roots", async () => {
    const runCommand = vi.fn(async () =>
      [
        "10 1 ZCode E2E",
        "11 10 zcode-host-local-1",
        "12 11 zcode-cli",
        "13 12 zcode-browser-use-mcp",
        "20 1 unrelated",
      ].join("\n"),
    );

    const processes = await listSystemProcesses({
      platform: "linux",
      runCommand,
    });

    expect(collectProcessTreeByRootPids(processes, [10])).toEqual([
      { command: "ZCode E2E", pid: 10, ppid: 1 },
      { command: "zcode-host-local-1", pid: 11, ppid: 10 },
      { command: "zcode-cli", pid: 12, ppid: 11 },
      { command: "zcode-browser-use-mcp", pid: 13, ppid: 12 },
    ]);
  });

  it("uses the shared PowerShell fallback for Windows process trees", () => {
    const runCommand = vi
      .fn<(command: string, args: string[]) => string>()
      .mockImplementationOnce(() => {
        throw new Error("Windows PowerShell unavailable");
      })
      .mockReturnValueOnce(
        toProcessJson([
          {
            command: `electron.exe ${CURRENT_HOME_MARKER}`,
            parentPid: 1,
            pid: 101,
          },
          { command: "node.exe host-process", parentPid: 101, pid: 102 },
        ]),
      );

    expect(
      listE2EProcessTreePids(
        { currentPid: 999, homeDir: CURRENT_HOME },
        { platform: "win32", runCommand },
      ),
    ).toEqual([102, 101]);
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual(["powershell.exe", "pwsh"]);
  });

  it("does not treat shared app title or build paths as cleanup identity", () => {
    const sharedEntryPoint = "/repo/packages/desktop/out/main/index.js";
    const sharedMainDir = "/repo/packages/desktop/out/main";
    const processes = [
      {
        command: `Electron "ZCode E2E" --app=${sharedEntryPoint} --inspect=${sharedMainDir}`,
        pid: 10,
        ppid: 1,
      },
      { command: "node host-process", pid: 11, ppid: 10 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 999,
        homeDir: "/tmp/zcode-e2e-run-a",
        runId: "run-a",
      }),
    ).toEqual([]);
  });

  it("matches the current HOME with Windows and slash-normalized paths", () => {
    const output = toProcessJson([
      {
        command: `electron.exe ${CURRENT_HOME_MARKER}`,
        parentPid: 1,
        pid: 101,
      },
      {
        command: "node.exe --config=C:/e2e/shards/current/.zcode/cli/config.json",
        parentPid: 101,
        pid: 102,
      },
    ]);

    expect(
      collectWindowsE2EProcessTreePids(output, {
        currentPid: 999,
        homeDir: CURRENT_HOME,
      }),
    ).toEqual([102, 101]);
  });

  it("does not select another shard with the same app entry point or a HOME prefix", () => {
    const sharedApp = "C:\\repo\\packages\\desktop\\out\\main\\index.js";
    const output = toProcessJson([
      {
        command: `electron.exe --app=${sharedApp} --name="ZCode E2E" ${CURRENT_HOME_MARKER}`,
        parentPid: 1,
        pid: 201,
      },
      {
        command: `electron.exe --app=${sharedApp} --name="ZCode E2E" ${createWindowsE2EHomeMarkerArg("C:\\e2e\\shards\\other")}`,
        parentPid: 1,
        pid: 202,
      },
      {
        command: `electron.exe --app=${sharedApp} --name="ZCode E2E" ${createWindowsE2EHomeMarkerArg(`${CURRENT_HOME}-copy`)}`,
        parentPid: 1,
        pid: 203,
      },
    ]);

    expect(
      collectWindowsE2EProcessTreePids(output, {
        currentPid: 999,
        homeDir: CURRENT_HOME,
      }),
    ).toEqual([201]);
  });

  it("excludes the current process, its ancestors, and WDIO controllers", () => {
    const processes = [
      { command: `node parent ${CURRENT_HOME_MARKER}`, pid: 400, ppid: 1 },
      { command: `node runner ${CURRENT_HOME_MARKER}`, pid: 401, ppid: 400 },
      { command: `node @wdio/cli ${CURRENT_HOME_MARKER}`, pid: 402, ppid: 1 },
      {
        command: `node wdio.conf.ts ${CURRENT_HOME_MARKER}`,
        pid: 403,
        ppid: 1,
      },
      { command: "node controller-child", pid: 404, ppid: 402 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 401,
        homeDir: CURRENT_HOME,
      }),
    ).toEqual([]);
  });

  it("matches run id arguments with command boundaries", () => {
    const processes = [
      {
        command: `Electron ${buildE2ERunIdArg("run-1-extra")}`,
        pid: 10,
        ppid: 1,
      },
      { command: `Electron ${buildE2ERunIdArg("run-1")}`, pid: 20, ppid: 1 },
    ];

    expect(
      collectE2EProcessTreePids(processes, {
        currentPid: 999,
        homeDir: "/tmp/zcode-e2e-run-1",
        runId: "run-1",
      }),
    ).toEqual([20]);
  });

  it.each(["", "not-json", "null", "{}"])(
    "treats malformed or empty Windows process JSON as no matches: %j",
    (output) => {
      expect(
        collectWindowsE2EProcessTreePids(output, {
          currentPid: 999,
          homeDir: CURRENT_HOME,
        }),
      ).toEqual([]);
    },
  );
});
