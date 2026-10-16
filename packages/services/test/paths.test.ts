import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-paths-home-"));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  process.env.HOME = originalHome;
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("paths", () => {
  it("copyDataDirectory 会复制普通文件并跳过 workspace 里的共享目录软链", async () => {
    const oldBase = makeTempHome();
    const newBase = makeTempHome();
    process.env.HOME = oldBase;
    vi.resetModules();

    const { copyDataDirectory } = await import("../src/paths.js");
    const oldV2Dir = join(oldBase, ".zcode", "v2");
    const oldSharedSkillRoot = join(oldV2Dir, "agent-config", "claude", "skills");
    const oldSharedPluginRoot = join(oldV2Dir, "agent-config", "claude", "plugins");
    const oldWorkspaceRoot = join(oldV2Dir, "agent-config", "claude", "workspace-hash-1");
    mkdirSync(join(oldSharedSkillRoot, "demo-skill"), { recursive: true });
    writeFileSync(join(oldSharedSkillRoot, "demo-skill", "SKILL.md"), "demo", "utf-8");
    mkdirSync(oldSharedPluginRoot, { recursive: true });
    writeFileSync(join(oldSharedPluginRoot, "installed_plugins.json"), '{"plugins":{}}', "utf-8");
    mkdirSync(oldWorkspaceRoot, { recursive: true });
    writeFileSync(join(oldWorkspaceRoot, "settings.json"), '{"model":"demo"}', "utf-8");
    const linkType: "dir" | "junction" = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(oldSharedSkillRoot, join(oldWorkspaceRoot, "skills"), linkType);
    symlinkSync(oldSharedPluginRoot, join(oldWorkspaceRoot, "plugins"), linkType);

    await copyDataDirectory(oldBase, newBase);

    const newV2Dir = join(newBase, ".zcode", "v2");
    const newWorkspaceRoot = join(newV2Dir, "agent-config", "claude", "workspace-hash-1");
    const newSkillLink = join(newWorkspaceRoot, "skills");
    const newPluginLink = join(newWorkspaceRoot, "plugins");

    expect(readFileSync(join(newWorkspaceRoot, "settings.json"), "utf-8")).toBe('{"model":"demo"}');
    expect(existsSync(newSkillLink)).toBe(false);
    expect(existsSync(newPluginLink)).toBe(false);
  });

  it("copyDataDirectory 会跳过 setting.json 及其原子写入瞬时文件", async () => {
    const oldBase = makeTempHome();
    const newBase = makeTempHome();
    const oldV2Dir = join(oldBase, ".zcode", "v2");
    const newV2Dir = join(newBase, ".zcode", "v2");
    mkdirSync(oldV2Dir, { recursive: true });
    writeFileSync(join(oldV2Dir, "setting.json"), '{"dataBaseDir":"/old"}', "utf-8");
    writeFileSync(join(oldV2Dir, "setting.json.lock"), "lock", "utf-8");
    writeFileSync(join(oldV2Dir, "setting.json.123.tmp"), "temp", "utf-8");
    writeFileSync(join(oldV2Dir, "app-canary.txt"), "app-data", "utf-8");

    vi.resetModules();
    const { copyDataDirectory } = await import("../src/paths.js");
    await copyDataDirectory(oldBase, newBase);

    expect(readFileSync(join(newV2Dir, "app-canary.txt"), "utf-8")).toBe("app-data");
    expect(existsSync(join(newV2Dir, "setting.json"))).toBe(false);
    expect(existsSync(join(newV2Dir, "setting.json.lock"))).toBe(false);
    expect(existsSync(join(newV2Dir, "setting.json.123.tmp"))).toBe(false);
  });

  it("Windows 数据目录不能选择 ZCode 安装目录或其子目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("c:\\program files\\zcode", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode\\data", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
  });

  it("Windows 数据目录保护不会误伤同名前缀的普通目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCodeData", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\Documents\\ZCode", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
  });
});
