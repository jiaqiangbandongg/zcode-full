import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node-pty", () => ({
  spawn: spawnMock,
}));

import {
  parseWindowsBuildNumber,
  createTerminalService,
  resolveTerminalEnv,
  resolveTerminalCwd,
  resolveTerminalShell,
  resolveTerminalWindowsPtyInfo,
} from "../src/terminal/terminalService.js";

const originalShell = process.env.SHELL;
const originalHome = process.env.HOME;
const originalLang = process.env.LANG;
const originalLcAll = process.env.LC_ALL;
const originalLcCtype = process.env.LC_CTYPE;
const originalTerm = process.env.TERM;
const originalColorTerm = process.env.COLORTERM;
const originalCi = process.env.CI;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalComSpec = process.env.ComSpec;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const tempDirs: string[] = [];

function getExpectedResolvedShellPattern() {
  return process.platform === "win32"
    ? /(?:^|[\\/])(pwsh|powershell|cmd)\.exe$|^(pwsh|powershell|cmd)\.exe$/i
    : /^\/bin\/(zsh|bash|sh)$/;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function prependFakeWindowsShells(commands: string[]): string {
  const dir = makeTempDir("zcode-terminal-shells-");
  for (const command of commands) {
    const shellPath = join(dir, command);
    writeFileSync(shellPath, "");
    chmodSync(shellPath, 0o755);
  }
  process.env.PATH = dir;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  delete process.env.ComSpec;
  return dir;
}

function createMockPty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}


function createTestTerminalService(settings = {}) {
  return createTerminalService({
    settingService: {
      get: vi.fn().mockResolvedValue({
        recentProjects: [],
        locale: "zh-CN",
        terminalInheritSystemProfile: true,
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
        ...settings,
      }),
      update: vi.fn(),
      updateDataBaseDir: vi.fn(),
      ensureDefaultProject: vi.fn(),
    } as any,
  });
}

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(createMockPty());
});

afterEach(() => {
  process.env.SHELL = originalShell;
  process.env.HOME = originalHome;
  restoreEnv("LANG", originalLang);
  restoreEnv("LC_ALL", originalLcAll);
  restoreEnv("LC_CTYPE", originalLcCtype);
  restoreEnv("TERM", originalTerm);
  restoreEnv("COLORTERM", originalColorTerm);
  restoreEnv("CI", originalCi);
  restoreEnv("PATH", originalPath);
  restoreEnv("PATHEXT", originalPathExt);
  restoreEnv("ComSpec", originalComSpec);
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("terminalService", () => {
  it("should fall back to a usable shell when SHELL points to a missing executable", () => {
    const invalidShell = join(tmpdir(), `zcode-missing-shell-${Date.now()}`);
    process.env.SHELL = invalidShell;

    const shell = resolveTerminalShell();

    expect(shell).not.toBe(invalidShell);
    expect(shell).toMatch(getExpectedResolvedShellPattern());
  });

  it("should prefer pwsh over legacy powershell on Windows", () => {
    setProcessPlatform("win32");
    prependFakeWindowsShells(["pwsh.exe", "powershell.exe", "cmd.exe"]);

    expect(resolveTerminalShell()).toBe("pwsh.exe");
  });

  it("should expose Windows ConPTY compatibility info only on Windows", () => {
    expect(parseWindowsBuildNumber("10.0.19045")).toBe(19045);
    expect(resolveTerminalWindowsPtyInfo("win32", "10.0.19041")).toEqual({
      backend: "conpty",
      buildNumber: 19041,
    });
    expect(resolveTerminalWindowsPtyInfo("darwin", "23.0.0")).toBeUndefined();
  });

  it("should keep the provided cwd when it still exists", () => {
    const cwd = makeTempDir("zcode-terminal-cwd-");

    expect(resolveTerminalCwd(cwd)).toBe(cwd);
  });

  it("should fall back to HOME when the provided cwd is gone", () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;

    const cwd = resolveTerminalCwd(join(tmpdir(), `zcode-missing-cwd-${Date.now()}`));

    expect(cwd).toBe(home);
  });

  it("should provide a UTF-8 locale when the parent process has C locale", () => {
    const env = resolveTerminalEnv({
      PATH: "/bin",
      LANG: "",
      LC_ALL: "",
      LC_CTYPE: "C",
      TERM: "dumb",
      CI: "1",
    });

    if (process.platform === "darwin") {
      expect(env.PATH?.split(":")).toEqual(
        expect.arrayContaining(["/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]),
      );
    }
    expect(env.LANG).toMatch(/utf-?8/i);
    expect(env.LC_ALL).toMatch(/utf-?8/i);
    expect(env.LC_CTYPE).toMatch(/utf-?8/i);
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.CI).toBeUndefined();
  });

  it("should add common macOS command paths for GUI-launched terminal environments", () => {
    const env = resolveTerminalEnv({
      PATH: "/usr/bin:/bin:/usr/bin",
    });

    if (process.platform !== "darwin") {
      expect(env.PATH).toBe("/usr/bin:/bin:/usr/bin");
      return;
    }

    expect(env.PATH?.split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
    ]);
  });

  it("should keep interactive terminal capabilities when spawning the terminal", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    process.env.TERM = "dumb";
    process.env.CI = "1";

    const service = createTestTerminalService();
    await service.create({ cols: 80, rows: 24, cwd: home });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
      }),
    );
    expect(spawnMock.mock.calls.at(-1)?.[2]?.env?.CI).toBeUndefined();
  });

  it("should keep an inherited UTF-8 locale when spawning the terminal", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    process.env.LANG = "zh_CN.UTF-8";
    process.env.LC_CTYPE = "C";
    delete process.env.LC_ALL;

    const service = createTestTerminalService();
    await service.create({ cols: 80, rows: 24, cwd: home });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          LANG: "zh_CN.UTF-8",
          LC_CTYPE: "zh_CN.UTF-8",
        }),
      }),
    );
  });

  it("should return the resolved terminal font profile", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL = process.platform === "win32" ? "powershell.exe" : "/bin/sh";

    const service = createTestTerminalService({
      terminalFontFamily: "MesloLGS NF",
    });
    const result = await service.create({ cols: 80, rows: 24, cwd: home });

    expect(result.fontFamily).toContain("MesloLGS NF");
    expect(result.fontFamilySource).toBe("custom");
  });

  it("should use resolved shell and cwd before spawning the terminal", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL = join(tmpdir(), `zcode-missing-shell-${Date.now()}`);

    const service = createTestTerminalService();
    await service.create({ cols: 80, rows: 24, cwd: join(tmpdir(), `zcode-missing-cwd-${Date.now()}`) });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(getExpectedResolvedShellPattern()),
      [],
      expect.objectContaining({
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: home,
      }),
    );
  });

  it("should wrap spawn failures with shell and cwd details", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL =
      process.platform === "win32" ? "/bin/sh" : "/bin/sh";
    spawnMock.mockImplementationOnce(() => {
      throw new Error("posix_spawnp failed");
    });

    const service = createTestTerminalService();
    const expectedShell = resolveTerminalShell().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    await expect(service.create({ cols: 80, rows: 24, cwd: home })).rejects.toThrow(
      new RegExp(`Failed to start terminal with shell '${expectedShell}' in '.*': posix_spawnp failed`),
    );
  });

  it("should fall back to system conpty when useConptyDll fails on Windows", async () => {
    setProcessPlatform("win32");
    prependFakeWindowsShells(["powershell.exe"]);
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    const fallbackPty = createMockPty();
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error("Failed to get conpty.node module handle, error code: 126");
      })
      .mockReturnValueOnce(fallbackPty);

    const service = createTestTerminalService();
    await service.create({ cols: 80, rows: 24, cwd: home });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "powershell.exe",
      [],
      expect.objectContaining({
        useConpty: true,
        useConptyDll: true,
        cwd: home,
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "powershell.exe",
      [],
      expect.objectContaining({
        useConpty: true,
        useConptyDll: false,
        cwd: home,
      }),
    );
  });

  it("should not fall back when Windows spawn fails for non-conpty reasons", async () => {
    setProcessPlatform("win32");
    prependFakeWindowsShells(["powershell.exe"]);
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    spawnMock.mockImplementationOnce(() => {
      throw new Error("powershell.exe not found");
    });

    const service = createTestTerminalService();

    await expect(service.create({ cols: 80, rows: 24, cwd: home })).rejects.toThrow(
      `Failed to start terminal with shell 'powershell.exe' in '${home}': powershell.exe not found`,
    );
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("should kill all active terminals when disposing the service", async () => {
    const home = makeTempDir("zcode-terminal-home-");
    process.env.HOME = home;
    process.env.SHELL = "/bin/sh";
    const firstPty = createMockPty();
    const secondPty = createMockPty();
    spawnMock
      .mockReturnValueOnce(firstPty)
      .mockReturnValueOnce(secondPty);

    const service = createTestTerminalService() as ReturnType<typeof createTestTerminalService> & {
      disposeAll: () => void;
    };
    await service.create({ cols: 80, rows: 24, cwd: home });
    await service.create({ cols: 120, rows: 30, cwd: home });

    service.disposeAll();

    expect(firstPty.kill).toHaveBeenCalledOnce();
    expect(secondPty.kill).toHaveBeenCalledOnce();
  });
});
