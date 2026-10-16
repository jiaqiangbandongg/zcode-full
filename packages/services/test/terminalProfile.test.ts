import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTerminalFontProfile } from "../src/terminal/terminalProfile.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const tempDirs: string[] = [];
const execFileSyncMock = vi.mocked(execFileSync);

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  execFileSyncMock.mockReset();

  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("terminalProfile", () => {
  it("prefers an explicit terminal font override", () => {
    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: "MesloLGS NF",
        terminalInheritSystemProfile: true,
      },
      env: {},
    });

    expect(profile.source).toBe("custom");
    expect(profile.fontFamily).toContain("MesloLGS NF");
    expect(profile.fontFamily).toContain("monospace");
  });

  it("detects the Windows Terminal default profile font", () => {
    setProcessPlatform("win32");
    const localAppData = makeTempDir("zcode-terminal-profile-localappdata-");
    const settingsDir = join(
      localAppData,
      "Packages",
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
      "LocalState",
    );
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      `{
        // JSONC comments and trailing commas are valid in Windows Terminal settings.
        "defaultProfile": "{zsh}",
        "profiles": {
          "list": [
            { "guid": "{zsh}", "font": { "face": "CaskaydiaCove Nerd Font" } },
          ],
        },
      }`,
      "utf8",
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      },
      env: { LOCALAPPDATA: localAppData },
    });

    expect(profile.source).toBe("system");
    expect(profile.fontFamily).toContain("CaskaydiaCove Nerd Font");
  });

  it("falls back when system profile inheritance is disabled", () => {
    setProcessPlatform("win32");
    const localAppData = makeTempDir("zcode-terminal-profile-localappdata-");
    const settingsDir = join(
      localAppData,
      "Packages",
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
      "LocalState",
    );
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        profiles: {
          defaults: { font: { face: "Ignored Nerd Font" } },
        },
      }),
      "utf8",
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: false,
      },
      env: { LOCALAPPDATA: localAppData },
    });

    expect(profile.source).toBe("fallback");
    expect(profile.fontFamily).not.toContain("Ignored Nerd Font");
  });

  it("detects the VS Code terminal font on Unix-like systems", () => {
    setProcessPlatform("linux");
    const home = makeTempDir("zcode-terminal-profile-home-");
    const settingsDir = join(home, ".config", "Code", "User");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ "terminal.integrated.fontFamily": "JetBrainsMono Nerd Font" }),
      "utf8",
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      },
      env: { HOME: home },
    });

    expect(profile.source).toBe("system");
    expect(profile.fontFamily).toContain("JetBrainsMono Nerd Font");
  });

  it("detects the default iTerm2 profile font as a macOS plugin", () => {
    setProcessPlatform("darwin");
    const home = makeTempDir("zcode-terminal-profile-home-");
    const preferencesDir = join(home, "Library", "Preferences");
    mkdirSync(preferencesDir, { recursive: true });
    writeFileSync(join(preferencesDir, "com.googlecode.iterm2.plist"), "plist", "utf8");
    execFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        "New Bookmarks": [
          {
            Name: "Default",
            "Default Bookmark": true,
            "Normal Font": "MesloLGS-NF-Regular 13",
            "Foreground Color": {
              "Red Component": 0.9,
              "Green Component": 0.85,
              "Blue Component": 0.8,
            },
            "Background Color": {
              "Red Component": 0.1,
              "Green Component": 0.12,
              "Blue Component": 0.14,
            },
            "Ansi 1 Color": {
              "Red Component": 1,
              "Green Component": 0.2,
              "Blue Component": 0.1,
            },
            "Ansi 9 Color": {
              "Red Component": 1,
              "Green Component": 0.4,
              "Blue Component": 0.35,
            },
          },
        ],
      }),
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      },
      env: { HOME: home },
    });

    expect(profile.source).toBe("system");
    expect(profile.fontFamily).toContain("MesloLGS NF Regular");
    expect(profile.fontSize).toBe(13);
    expect(profile.theme).toMatchObject({
      background: "#1a1f24",
      foreground: "#e6d9cc",
      red: "#ff331a",
      brightRed: "#ff6659",
    });
  });

  it("detects macOS Terminal font when iTerm2 is unavailable", () => {
    setProcessPlatform("darwin");
    const home = makeTempDir("zcode-terminal-profile-home-");
    const preferencesDir = join(home, "Library", "Preferences");
    mkdirSync(preferencesDir, { recursive: true });
    writeFileSync(join(preferencesDir, "com.apple.Terminal.plist"), "plist", "utf8");
    execFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        "Default Window Settings": "Pro",
        Pro: {
          FontName: "SF Mono",
          FontSize: 14,
          TextColor: {
            "Red Component": 0.8,
            "Green Component": 0.82,
            "Blue Component": 0.84,
          },
          BackgroundColor: {
            "Red Component": 0.05,
            "Green Component": 0.06,
            "Blue Component": 0.07,
          },
          ANSIBlueColor: {
            "Red Component": 0.2,
            "Green Component": 0.4,
            "Blue Component": 1,
          },
        },
      }),
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      },
      env: { HOME: home },
    });

    expect(profile.source).toBe("system");
    expect(profile.fontFamily).toContain("SF Mono");
    expect(profile.fontSize).toBe(14);
    expect(profile.theme).toMatchObject({
      background: "#0d0f12",
      foreground: "#ccd1d6",
      blue: "#3366ff",
    });
  });

  it("keeps macOS profile size and theme when an explicit font override is configured", () => {
    setProcessPlatform("darwin");
    const home = makeTempDir("zcode-terminal-profile-home-");
    const preferencesDir = join(home, "Library", "Preferences");
    mkdirSync(preferencesDir, { recursive: true });
    writeFileSync(join(preferencesDir, "com.googlecode.iterm2.plist"), "plist", "utf8");
    execFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        "New Bookmarks": [
          {
            Name: "Default",
            "Default Bookmark": true,
            "Normal Font": "Menlo-Regular 15",
            "Cursor Color": {
              "Red Component": 0.1,
              "Green Component": 0.9,
              "Blue Component": 0.5,
            },
          },
        ],
      }),
    );

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: "Custom Mono",
        terminalInheritSystemProfile: true,
      },
      env: { HOME: home },
    });

    expect(profile.source).toBe("custom");
    expect(profile.fontFamily).toContain("Custom Mono");
    expect(profile.fontSize).toBe(15);
    expect(profile.theme).toMatchObject({ cursor: "#1ae680" });
  });

  it("skips failing macOS terminal plugins and continues to fallback", () => {
    setProcessPlatform("darwin");
    const home = makeTempDir("zcode-terminal-profile-home-");
    const preferencesDir = join(home, "Library", "Preferences");
    mkdirSync(preferencesDir, { recursive: true });
    writeFileSync(join(preferencesDir, "com.googlecode.iterm2.plist"), "plist", "utf8");
    writeFileSync(join(preferencesDir, "com.apple.Terminal.plist"), "plist", "utf8");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("plutil failed");
    });

    const profile = resolveTerminalFontProfile({
      settings: {
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      },
      env: { HOME: home },
    });

    expect(profile.source).toBe("fallback");
    expect(profile.fontFamily).toContain("monospace");
  });
});
