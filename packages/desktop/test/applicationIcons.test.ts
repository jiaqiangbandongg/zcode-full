import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getFileIcon: vi.fn() } }));

import {
  createApplicationIconLoader,
  resolveDarwinApplicationPath,
} from "../src/main/applicationIcons.js";
import { createWindowsAumidIconReader } from "../src/main/windowsAumidIcon.js";

function nativeImage(dataUrl: string) {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
}

describe("application icon locators", () => {
  it("reads AUMID icons from the Windows AppsFolder Shell namespace", async () => {
    const execute = vi.fn(async () => Buffer.from("png").toString("base64"));
    const readIcon = createWindowsAumidIconReader({
      execute,
      systemRoot: "C:\\Windows",
    });

    await expect(readIcon("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).resolves.toEqual({
      iconDataUrl: "data:image/png;base64,cG5n",
    });
    const [command, args, timeout] = execute.mock.calls[0]!;
    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(timeout).toBe(5_000);
    const encodedCommand = Buffer.from(args[4]!, "base64").toString("utf16le");
    expect(encodedCommand).toContain("SHCreateItemInKnownFolder");
    expect(encodedCommand).toContain("1e87508d-89c2-42f0-8a7e-645a0f50ca58");
    expect(encodedCommand).not.toContain("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
  });

  it("按大小写不敏感解析 darwin bundle id，Spotlight 与兜底索引口径一致", async () => {
    // CUA producer 的 appKey 是 `darwin:<bundleId.toLowerCase()>`，而 Info.plist 里是
    // `com.apple.Notes`。Spotlight 查询本来就带 `c` 后缀（大小写不敏感），兜底索引若保持精确
    // 匹配，就只在 Spotlight 不可用的机器上取不到 CUA 工具卡的 App 图标。
    const listDirectory = vi.fn(async (path: string) =>
      path === "/Applications" ? ["Notes.app", "NotAnApp.txt"] : [],
    );
    const execute = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/usr/bin/mdfind") throw new Error("spotlight disabled");
      expect(command).toBe("/usr/libexec/PlistBuddy");
      expect(args.at(-1)).toBe("/Applications/Notes.app/Contents/Info.plist");
      return "com.apple.Notes\n";
    });
    const dependencies = {
      execute,
      listDirectory,
      homeDirectory: "/Users/tester",
      now: () => 0,
    };

    await expect(resolveDarwinApplicationPath("com.apple.notes", dependencies)).resolves.toBe(
      "/Applications/Notes.app",
    );
    // 原始大小写同样命中，不能为了兼容小写反过来把旧输入判错。
    await expect(resolveDarwinApplicationPath("com.apple.Notes", dependencies)).resolves.toBe(
      "/Applications/Notes.app",
    );
    // 不存在的 bundle id 仍返回 null，而不是退化成任意一个已索引应用。
    await expect(
      resolveDarwinApplicationPath("com.example.missing", dependencies),
    ).resolves.toBeNull();
  });

  it("reads a normal Windows executable with Electron getFileIcon", async () => {
    const getFileIcon = vi.fn(async () => nativeImage("data:image/png;base64,EXE"));
    const load = createApplicationIconLoader({
      platform: "win32",
      getFileIcon,
      resolveDarwinApplicationPath: vi.fn(),
    });

    await expect(
      load({
        locators: [
          { kind: "windows-executable-path", value: "C:\\Windows\\System32\\notepad.exe" },
        ],
      }),
    ).resolves.toEqual({ iconDataUrl: "data:image/png;base64,EXE" });
    expect(getFileIcon).toHaveBeenCalledWith("C:\\Windows\\System32\\notepad.exe", {
      size: "normal",
    });
  });

  it("rejects UNC and device executable paths before Electron file access", async () => {
    const getFileIcon = vi.fn(async () => nativeImage("data:image/png;base64,REMOTE"));
    const load = createApplicationIconLoader({
      platform: "win32",
      getFileIcon,
      resolveDarwinApplicationPath: vi.fn(),
    });

    for (const request of [
      {
        locators: [
          { kind: "windows-executable-path" as const, value: "\\\\attacker\\share\\a.exe" },
        ],
      },
      {
        locators: [
          { kind: "windows-executable-path" as const, value: "\\\\?\\C:\\Windows\\a.exe" },
        ],
      },
      "\\\\attacker\\share\\a.exe",
      "C:\\Windows\\System32\\notepad.exe",
    ]) {
      await expect(load(request)).resolves.toBeNull();
    }
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it("uses the Windows AppsFolder Shell identity for an AUMID", async () => {
    const getFileIcon = vi.fn(async () => nativeImage("data:image/png;base64,UWP"));
    const readWindowsAumidIcon = vi.fn(async () => ({
      iconDataUrl: "data:image/png;base64,UWP",
    }));
    const load = createApplicationIconLoader({
      platform: "win32",
      getFileIcon,
      resolveDarwinApplicationPath: vi.fn(),
      readWindowsAumidIcon,
    });

    await load({
      locators: [
        {
          kind: "windows-aumid",
          value: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        },
        {
          kind: "windows-executable-path",
          value: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
        },
      ],
    });

    expect(readWindowsAumidIcon).toHaveBeenCalledWith(
      "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
    );
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it("rejects ApplicationFrameHost when no AUMID was authorized", async () => {
    const getFileIcon = vi.fn();
    const load = createApplicationIconLoader({
      platform: "win32",
      getFileIcon,
      resolveDarwinApplicationPath: vi.fn(),
    });

    await expect(
      load({
        locators: [
          {
            kind: "windows-executable-path",
            value: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
          },
        ],
      }),
    ).resolves.toBeNull();
    expect(getFileIcon).not.toHaveBeenCalled();
  });
});
