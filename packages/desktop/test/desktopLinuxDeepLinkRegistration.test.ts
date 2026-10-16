import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

type CommandCall = { command: string; args: string[] };

function readPngSize(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("desktop Linux deep link registration helpers", () => {
  it("prefers the AppImage path for protocol desktop entry Exec", async () => {
    const { createLinuxDeepLinkDesktopEntry, resolveLinuxDeepLinkCommand } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const command = resolveLinuxDeepLinkCommand({
      env: { APPIMAGE: "/home/alice/Downloads/ZCode-2.8.0-linux-x64.AppImage" },
      executablePath: "/tmp/.mount_ZCode/zcode",
    });
    const entry = createLinuxDeepLinkDesktopEntry(command);

    expect(command.executablePath).toBe("/home/alice/Downloads/ZCode-2.8.0-linux-x64.AppImage");
    expect(entry).toContain('Exec="/home/alice/Downloads/ZCode-2.8.0-linux-x64.AppImage" %U');
    expect(entry).toContain("MimeType=x-scheme-handler/zcode;");
  });

  it("keeps AppImage sandbox and GPU launch switches for protocol callbacks", async () => {
    const { createLinuxDeepLinkDesktopEntry, resolveLinuxDeepLinkCommand } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const command = resolveLinuxDeepLinkCommand({
      env: { APPIMAGE: "/home/alice/Applications/ZCode.AppImage" },
      executablePath: "/tmp/.mount_ZCode/zcode",
      argv: [
        "/tmp/.mount_ZCode/zcode",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--use-gl=swiftshader",
        "--remote-debugging-port=9229",
        "zcode://oauth/callback?code=1&state=s",
        "/home/alice/project",
      ],
    });
    const entry = createLinuxDeepLinkDesktopEntry(command);

    expect(command.args).toEqual([
      "--no-sandbox",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--use-gl=swiftshader",
    ]);
    expect(entry).toContain(
      'Exec="/home/alice/Applications/ZCode.AppImage" "--no-sandbox" "--disable-gpu" "--disable-software-rasterizer" "--use-gl=swiftshader" %U',
    );
    expect(entry).not.toContain("remote-debugging-port");
    expect(entry).not.toContain("oauth/callback");
    expect(entry).not.toContain("/home/alice/project");
  });

  it("does not persist launch switches for non-AppImage Linux installs", async () => {
    const { createLinuxDeepLinkDesktopEntry, resolveLinuxDeepLinkCommand } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const command = resolveLinuxDeepLinkCommand({
      env: {},
      executablePath: "/opt/ZCode/zcode",
      argv: ["/opt/ZCode/zcode", "--no-sandbox", "--disable-gpu"],
    });
    const entry = createLinuxDeepLinkDesktopEntry(command);

    expect(command).toEqual({ executablePath: "/opt/ZCode/zcode", args: [] });
    expect(entry).toContain('Exec="/opt/ZCode/zcode" %U');
  });

  it("escapes desktop Exec paths before writing user-level handlers", async () => {
    const { createLinuxDeepLinkDesktopEntry } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const entry = createLinuxDeepLinkDesktopEntry({
      executablePath: '/home/alice/Downloads/ZCode "Nightly".AppImage',
    });

    expect(entry).toContain('Exec="/home/alice/Downloads/ZCode \\"Nightly\\".AppImage" %U');
  });

  it("writes the Preview product name into the shared Linux protocol handler", async () => {
    const { createLinuxDeepLinkDesktopEntry } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const entry = createLinuxDeepLinkDesktopEntry({
      executablePath: "/opt/ZCode Preview/zcode-preview",
      productName: "ZCode Preview",
    });

    expect(entry).toContain("Name=ZCode Preview");
    expect(entry).toContain("StartupWMClass=ZCode Preview");
    expect(entry).toContain('Exec="/opt/ZCode Preview/zcode-preview" %U');
    expect(entry).toContain("MimeType=x-scheme-handler/zcode;");
  });

  it("escapes AppImage callback switches before writing desktop Exec", async () => {
    const { createLinuxDeepLinkDesktopEntry } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    const entry = createLinuxDeepLinkDesktopEntry({
      executablePath: "/home/alice/Downloads/ZCode.AppImage",
      args: ['--disable-features=UseOzonePlatform,"Quoted"'],
    });

    expect(entry).toContain(
      'Exec="/home/alice/Downloads/ZCode.AppImage" "--disable-features=UseOzonePlatform,\\"Quoted\\"" %U',
    );
  });

  it("installs a user-level hicolor icon only for AppImage launches", async () => {
    const { resolveLinuxUserDataDir } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const { installLinuxAppImageDesktopIcon, shouldInstallAppImageDesktopIcon } =
      await import("../src/main/desktopLinuxAppImageIcon.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-icon-"));
    const iconSourcePath = join(import.meta.dirname, "..", "build", "icons", "512x512.png");
    const homeDir = join(tempRoot, "home");
    const dataDir = resolveLinuxUserDataDir({ homeDir });
    const commandCalls: CommandCall[] = [];

    try {
      expect(readPngSize(iconSourcePath)).toEqual({ width: 512, height: 512 });

      expect(
        shouldInstallAppImageDesktopIcon({
          env: { APPIMAGE: "/home/alice/Applications/ZCode.AppImage" },
          iconSourcePath,
        }),
      ).toBe(true);
      expect(shouldInstallAppImageDesktopIcon({ env: {}, iconSourcePath })).toBe(false);

      const result = installLinuxAppImageDesktopIcon({
        dataDir,
        iconSourcePath,
        logger: { info: () => undefined, warn: () => undefined },
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return { status: 0, stderr: "" };
        },
      });

      expect(result).toEqual({
        iconFilePath: join(dataDir, "icons", "hicolor", "512x512", "apps", "zcode.png"),
        installed: true,
        changed: true,
      });
      expect(existsSync(result.iconFilePath)).toBe(true);
      expect(readPngSize(result.iconFilePath)).toEqual({ width: 512, height: 512 });
      expect(commandCalls).toEqual([
        {
          command: "gtk-update-icon-cache",
          args: ["-f", "-t", join(dataDir, "icons", "hicolor")],
        },
      ]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("uses XDG_DATA_HOME for user-level desktop entries and icons", async () => {
    const { resolveLinuxUserDataDir } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    expect(
      resolveLinuxUserDataDir({
        env: { XDG_DATA_HOME: "/tmp/xdg-data" },
        homeDir: "/home/alice",
      }),
    ).toBe("/tmp/xdg-data");
    expect(resolveLinuxUserDataDir({ env: { XDG_DATA_HOME: " " }, homeDir: "/home/alice" })).toBe(
      join("/home/alice", ".local", "share"),
    );
  });

  it("keeps desktop entry registration when optional AppImage icon install fails", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-registration-"));
    const homeDir = join(tempRoot, "home");
    const badIconSourcePath = join(tempRoot, "icon-source-directory");
    const warnings: unknown[][] = [];
    const commandCalls: CommandCall[] = [];

    try {
      mkdirSync(badIconSourcePath, { recursive: true });
      registerLinuxDeepLinkProtocol({
        executablePath: "/tmp/.mount_ZCode/zcode",
        homeDir,
        iconSourcePath: badIconSourcePath,
        env: { APPIMAGE: "/home/alice/Applications/ZCode.AppImage" },
        // 固定系统级目录为空，避免测试机恰好装了 ZCode 系统包时走清理分支。
        systemApplicationDirs: [join(tempRoot, "empty-system-applications")],
        logger: {
          info: () => undefined,
          warn: (...args: unknown[]) => warnings.push(args),
        },
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return { status: 0, stderr: "" };
        },
      });

      const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
      expect(existsSync(desktopFilePath)).toBe(true);
      expect(readFileSync(desktopFilePath, "utf8")).toContain(
        'Exec="/home/alice/Applications/ZCode.AppImage" %U',
      );
      expect(
        warnings.some(([message]) => message === "[deep-link] Linux AppImage 图标安装失败，已降级"),
      ).toBe(true);
      expect(commandCalls).toEqual([
        {
          command: "update-desktop-database",
          args: [join(homeDir, ".local", "share", "applications")],
        },
        {
          command: "xdg-mime",
          args: ["default", "zcode.desktop", "x-scheme-handler/zcode"],
        },
      ]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves system application dirs from XDG_DATA_DIRS with spec defaults", async () => {
    const { resolveLinuxSystemApplicationDirs } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");

    expect(
      resolveLinuxSystemApplicationDirs({
        XDG_DATA_DIRS: " /opt/custom/share :/usr/share: ",
      }),
    ).toEqual([join("/opt/custom/share", "applications"), join("/usr/share", "applications")]);
    expect(resolveLinuxSystemApplicationDirs({ XDG_DATA_DIRS: "::" })).toEqual([
      join("/usr/local/share", "applications"),
      join("/usr/share", "applications"),
    ]);
    expect(resolveLinuxSystemApplicationDirs()).toEqual([
      join("/usr/local/share", "applications"),
      join("/usr/share", "applications"),
    ]);
  });

  it("removes the stale owned user-level entry when a system-level entry exists", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-system-entry-"));
    const homeDir = join(tempRoot, "home");
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
    const infos: unknown[][] = [];
    const commandCalls: CommandCall[] = [];

    try {
      // 模拟 rpm/deb 安装产物：/usr/share/applications/zcode.desktop。
      mkdirSync(systemApplicationsDir, { recursive: true });
      writeFileSync(
        join(systemApplicationsDir, "zcode.desktop"),
        "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
        "utf8",
      );
      // 模拟旧 AppImage 时代遗留的用户级条目（含归属标记 Comment 行）。
      mkdirSync(dirname(desktopFilePath), { recursive: true });
      writeFileSync(
        desktopFilePath,
        [
          "[Desktop Entry]",
          "Name=ZCode",
          "Comment=ZCode Desktop App",
          'Exec="/home/alice/Downloads/ZCode-2.8.0-linux-x64.AppImage" %U',
          "MimeType=x-scheme-handler/zcode;",
          "",
        ].join("\n"),
        "utf8",
      );

      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [systemApplicationsDir],
        logger: {
          info: (...args: unknown[]) => infos.push(args),
          warn: () => undefined,
        },
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return { status: 0, stderr: "" };
        },
      });

      // 用户级遗留条目必须被清掉，让系统级条目在 XDG 解析中生效。
      expect(existsSync(desktopFilePath)).toBe(false);
      expect(commandCalls).toEqual([
        {
          command: "update-desktop-database",
          args: [join(homeDir, ".local", "share", "applications")],
        },
        {
          command: "xdg-mime",
          args: ["default", "zcode.desktop", "x-scheme-handler/zcode"],
        },
      ]);
      expect(
        infos.some(([message]) => message === "[deep-link] Linux 系统级 desktop entry 已存在"),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps a custom user-level entry untouched when a system-level entry exists", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-custom-entry-"));
    const homeDir = join(tempRoot, "home");
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
    const warnings: unknown[][] = [];

    try {
      mkdirSync(systemApplicationsDir, { recursive: true });
      writeFileSync(
        join(systemApplicationsDir, "zcode.desktop"),
        "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
        "utf8",
      );
      // 用户手写的自定义条目：没有我们的归属标记，不应被静默删除。
      mkdirSync(dirname(desktopFilePath), { recursive: true });
      const customEntry =
        "[Desktop Entry]\nName=ZCode\nComment=Custom wrapper\nExec=/home/alice/wrap.sh %U\n";
      writeFileSync(desktopFilePath, customEntry, "utf8");

      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [systemApplicationsDir],
        logger: {
          info: () => undefined,
          warn: (...args: unknown[]) => warnings.push(args),
        },
        runCommand: () => ({ status: 0, stderr: "" }),
      });

      expect(existsSync(desktopFilePath)).toBe(true);
      expect(readFileSync(desktopFilePath, "utf8")).toBe(customEntry);
      expect(
        warnings.some(
          ([message]) =>
            message === "[deep-link] Linux 用户级 zcode.desktop 非本应用写入，保留不清理",
        ),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not shadow a system-level entry for AppImage launches", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-appimage-system-"));
    const homeDir = join(tempRoot, "home");
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
    const iconSourcePath = join(import.meta.dirname, "..", "build", "icons", "512x512.png");
    const commandCalls: CommandCall[] = [];

    try {
      mkdirSync(systemApplicationsDir, { recursive: true });
      writeFileSync(
        join(systemApplicationsDir, "zcode.desktop"),
        "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
        "utf8",
      );

      registerLinuxDeepLinkProtocol({
        executablePath: "/tmp/.mount_ZCode/zcode",
        homeDir,
        iconSourcePath,
        env: { APPIMAGE: "/home/alice/Applications/ZCode.AppImage" },
        systemApplicationDirs: [systemApplicationsDir],
        logger: { info: () => undefined, warn: () => undefined },
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return { status: 0, stderr: "" };
        },
      });

      // AppImage 不得再写用户级同名条目遮蔽系统级，也不安装用户级图标。
      expect(existsSync(desktopFilePath)).toBe(false);
      expect(
        existsSync(
          join(homeDir, ".local", "share", "icons", "hicolor", "512x512", "apps", "zcode.png"),
        ),
      ).toBe(false);
      expect(commandCalls).toEqual([
        {
          command: "update-desktop-database",
          args: [join(homeDir, ".local", "share", "applications")],
        },
        {
          command: "xdg-mime",
          args: ["default", "zcode.desktop", "x-scheme-handler/zcode"],
        },
      ]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("still writes the user-level entry when no system-level entry exists", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-no-system-"));
    const homeDir = join(tempRoot, "home");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");

    try {
      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [join(tempRoot, "empty-system-applications")],
        logger: { info: () => undefined, warn: () => undefined },
        runCommand: () => ({ status: 0, stderr: "" }),
      });

      expect(existsSync(desktopFilePath)).toBe(true);
      expect(readFileSync(desktopFilePath, "utf8")).toContain('Exec="/opt/ZCode/zcode" %U');
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("ignores non-regular system-level paths when probing for shadow entries", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-dir-system-"));
    const homeDir = join(tempRoot, "home");
    // 系统目录下的 zcode.desktop 是一个目录而非普通文件，不得视为有效系统条目。
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");

    try {
      mkdirSync(join(systemApplicationsDir, "zcode.desktop"), { recursive: true });
      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [systemApplicationsDir],
        logger: { info: () => undefined, warn: () => undefined },
        runCommand: () => ({ status: 0, stderr: "" }),
      });

      // 病态路径不抑制用户级注册。
      expect(existsSync(desktopFilePath)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps an unreadable user-level entry and continues protocol registration", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-unreadable-"));
    const homeDir = join(tempRoot, "home");
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
    const warnings: unknown[][] = [];
    const commandCalls: CommandCall[] = [];

    try {
      mkdirSync(systemApplicationsDir, { recursive: true });
      writeFileSync(
        join(systemApplicationsDir, "zcode.desktop"),
        "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
        "utf8",
      );
      mkdirSync(dirname(desktopFilePath), { recursive: true });
      writeFileSync(desktopFilePath, "unreadable-placeholder", "utf8");
      // chmod 000 让 readFileSync 抛 EACCES：归属无法确认时必须保守保留。
      chmodSync(desktopFilePath, 0o000);

      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [systemApplicationsDir],
        logger: {
          info: () => undefined,
          warn: (...args: unknown[]) => warnings.push(args),
        },
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return { status: 0, stderr: "" };
        },
      });

      expect(existsSync(desktopFilePath)).toBe(true);
      expect(
        warnings.some(
          ([message]) =>
            message === "[deep-link] Linux 用户级 zcode.desktop 非本应用写入，保留不清理",
        ),
      ).toBe(true);
      // 归属识别失败只降级，协议注册命令仍完整执行。
      expect(commandCalls).toEqual([
        {
          command: "update-desktop-database",
          args: [join(homeDir, ".local", "share", "applications")],
        },
        {
          command: "xdg-mime",
          args: ["default", "zcode.desktop", "x-scheme-handler/zcode"],
        },
      ]);
    } finally {
      chmodSync(desktopFilePath, 0o700);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("recognizes ownership markers with CRLF line endings", async () => {
    const { registerLinuxDeepLinkProtocol } =
      await import("../src/main/desktopLinuxDeepLinkRegistration.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-crlf-"));
    const homeDir = join(tempRoot, "home");
    const systemApplicationsDir = join(tempRoot, "system", "applications");
    const desktopFilePath = join(homeDir, ".local", "share", "applications", "zcode.desktop");
    const infos: unknown[][] = [];

    try {
      mkdirSync(systemApplicationsDir, { recursive: true });
      writeFileSync(
        join(systemApplicationsDir, "zcode.desktop"),
        "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
        "utf8",
      );
      // 旧版本写出的 LF 条目被 Windows 风格工具改写为 CRLF 后仍应识别为可清理。
      mkdirSync(dirname(desktopFilePath), { recursive: true });
      writeFileSync(
        desktopFilePath,
        [
          "[Desktop Entry]",
          "Name=ZCode",
          "Comment=ZCode Desktop App",
          'Exec="/home/alice/Downloads/ZCode.AppImage" %U',
          "MimeType=x-scheme-handler/zcode;",
          "",
        ].join("\r\n"),
        "utf8",
      );

      registerLinuxDeepLinkProtocol({
        executablePath: "/opt/ZCode/zcode",
        homeDir,
        env: {},
        systemApplicationDirs: [systemApplicationsDir],
        logger: {
          info: (...args: unknown[]) => infos.push(args),
          warn: () => undefined,
        },
        runCommand: () => ({ status: 0, stderr: "" }),
      });

      expect(existsSync(desktopFilePath)).toBe(false);
      expect(
        infos.some(
          ([message]) => message === "[deep-link] 已清理遗留的用户级 zcode.desktop，恢复系统级条目",
        ),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  // Bugfix：本用例靠 chmod 0o500 去掉目录写权限让 rmSync 抛 EPERM，Windows 的 chmod
  // 对目录是 no-op，删除照样成功，制造不出"删除失败"场景，本地 Windows 上必挂；
  // 降级路径由 Linux/macOS（含 CI）继续覆盖，Windows 跳过。
  it.skipIf(process.platform === "win32")(
    "continues protocol registration when removing the stale entry fails",
    async () => {
      const { registerLinuxDeepLinkProtocol } =
        await import("../src/main/desktopLinuxDeepLinkRegistration.js");
      const tempRoot = mkdtempSync(join(tmpdir(), "zcode-linux-rm-fail-"));
      const homeDir = join(tempRoot, "home");
      const systemApplicationsDir = join(tempRoot, "system", "applications");
      const applicationsDir = join(homeDir, ".local", "share", "applications");
      const desktopFilePath = join(applicationsDir, "zcode.desktop");
      const warnings: unknown[][] = [];
      const commandCalls: CommandCall[] = [];

      try {
        mkdirSync(systemApplicationsDir, { recursive: true });
        writeFileSync(
          join(systemApplicationsDir, "zcode.desktop"),
          "[Desktop Entry]\nName=ZCode\nExec=/opt/ZCode/zcode %U\n",
          "utf8",
        );
        mkdirSync(applicationsDir, { recursive: true });
        writeFileSync(
          desktopFilePath,
          '[Desktop Entry]\nComment=ZCode Desktop App\nExec="/old/ZCode.AppImage" %U\n',
          "utf8",
        );
        // 目录去掉写权限后 rmSync 失败（EPERM）：删除失败必须只降级，不得抛出或阻断注册。
        chmodSync(applicationsDir, 0o500);

        registerLinuxDeepLinkProtocol({
          executablePath: "/opt/ZCode/zcode",
          homeDir,
          env: {},
          systemApplicationDirs: [systemApplicationsDir],
          logger: {
            info: () => undefined,
            warn: (...args: unknown[]) => warnings.push(args),
          },
          runCommand: (command, args) => {
            commandCalls.push({ command, args });
            return { status: 0, stderr: "" };
          },
        });

        expect(existsSync(desktopFilePath)).toBe(true);
        expect(
          warnings.some(([message]) => message === "[deep-link] 清理遗留用户级 zcode.desktop 失败"),
        ).toBe(true);
        expect(commandCalls).toEqual([
          {
            command: "update-desktop-database",
            args: [applicationsDir],
          },
          {
            command: "xdg-mime",
            args: ["default", "zcode.desktop", "x-scheme-handler/zcode"],
          },
        ]);
      } finally {
        chmodSync(applicationsDir, 0o700);
        rmSync(tempRoot, { force: true, recursive: true });
      }
    },
  );
});
