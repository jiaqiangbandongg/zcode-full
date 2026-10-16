import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStandardChromeInstallations,
  discoverChromeProfile,
  parseRunningChromeInstallations,
  resolveChromeExecutablePath,
  type ChromeInstallationCandidate,
} from "../src/main/chromeProfileDiscovery.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-chrome-discovery-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function createUserData(options: {
  dataProfiles?: string[];
  lastUsed?: string;
  name?: string;
  profiles: string[];
}): Promise<ChromeInstallationCandidate> {
  const userDataDir = join(tempRoot, options.name ?? "User Data");
  const dataProfiles = new Set(options.dataProfiles ?? options.profiles);
  await mkdir(userDataDir, { recursive: true });
  for (const profile of options.profiles) {
    await mkdir(join(userDataDir, profile), { recursive: true });
    if (dataProfiles.has(profile)) {
      await mkdir(join(userDataDir, profile, "Network"), { recursive: true });
      await writeFile(join(userDataDir, profile, "Network", "Cookies"), "");
    }
  }
  await writeFile(
    join(userDataDir, "Local State"),
    JSON.stringify({
      profile: {
        last_used: options.lastUsed,
        info_cache: Object.fromEntries(options.profiles.map((profile) => [profile, {}])),
      },
    }),
  );
  return {
    browser: "chrome",
    userDataDir,
    executablePaths: [],
  };
}

describe("chromeProfileDiscovery", () => {
  it("优先选择 Local State 中最近使用的 Profile", async () => {
    const installation = await createUserData({
      lastUsed: "Profile 2",
      profiles: ["Default", "Profile 2"],
    });

    await expect(discoverChromeProfile({ installations: [installation] })).resolves.toMatchObject({
      success: true,
      source: {
        profileDirectory: "Profile 2",
        profilePath: join(installation.userDataDir, "Profile 2"),
      },
    });
  });

  it("最近使用项无效时 fallback 到 Default", async () => {
    const installation = await createUserData({
      lastUsed: "Profile 9",
      profiles: ["Default", "Profile 2"],
    });

    await expect(discoverChromeProfile({ installations: [installation] })).resolves.toMatchObject({
      success: true,
      source: { profileDirectory: "Default" },
    });
  });

  it("跳过没有浏览器数据的 Default，选择实际可导入的 Profile", async () => {
    const installation = await createUserData({
      dataProfiles: ["Profile 2"],
      lastUsed: "Default",
      profiles: ["Default", "Profile 2"],
    });

    await expect(discoverChromeProfile({ installations: [installation] })).resolves.toMatchObject({
      success: true,
      source: { profileDirectory: "Profile 2" },
    });
  });

  it("标准安装 Profile 为空时继续发现后续沙箱安装", async () => {
    const standardInstallation = await createUserData({
      dataProfiles: [],
      name: "XDG Chrome",
      profiles: ["Default"],
    });
    const snapInstallation = await createUserData({
      name: "Snap Chromium",
      profiles: ["Default"],
    });
    snapInstallation.browser = "chromium";

    await expect(
      discoverChromeProfile({ installations: [standardInstallation, snapInstallation] }),
    ).resolves.toMatchObject({
      success: true,
      source: {
        browser: "chromium",
        profilePath: join(snapInstallation.userDataDir, "Default"),
      },
    });
  });

  it("没有 Default 时选择唯一可用 Profile", async () => {
    const installation = await createUserData({ profiles: ["Profile 3"] });

    await expect(discoverChromeProfile({ installations: [installation] })).resolves.toMatchObject({
      success: true,
      source: { profileDirectory: "Profile 3" },
    });
  });

  it("多个 Profile 且无法确定来源时返回歧义错误", async () => {
    const installation = await createUserData({ profiles: ["Profile 2", "Profile 3"] });

    await expect(discoverChromeProfile({ installations: [installation] })).resolves.toEqual({
      success: false,
      error: "chrome_profile_ambiguous",
    });
  });

  it("发现运行中 Chrome 的自定义 user-data-dir", () => {
    expect(
      parseRunningChromeInstallations([
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="D:\\Chrome Data" --profile-directory="Profile 2"',
      ]),
    ).toEqual([
      expect.objectContaining({
        browser: "chrome",
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        userDataDir: "D:\\Chrome Data",
      }),
    ]);
  });

  it("保留 Linux Chrome 显式选择的受支持 password store", () => {
    expect(
      parseRunningChromeInstallations([
        "/usr/bin/google-chrome --user-data-dir=/home/demo/.config/google-chrome --password-store=kwallet6",
      ]),
    ).toEqual([
      expect.objectContaining({
        browser: "chrome",
        executablePath: "/usr/bin/google-chrome",
        passwordStore: "kwallet6",
        userDataDir: "/home/demo/.config/google-chrome",
      }),
    ]);
  });

  it("Linux Chrome 使用标准 Profile 时也合并运行进程的 password store", () => {
    const fallback: ChromeInstallationCandidate = {
      browser: "chrome",
      executablePaths: ["/usr/bin/google-chrome", "/opt/google/chrome/chrome"],
      userDataDir: "/home/demo/.config/google-chrome",
    };

    expect(
      parseRunningChromeInstallations(
        [
          "/opt/google/chrome/chrome --type=renderer --password-store=basic",
          "/opt/google/chrome/chrome --password-store=gnome-libsecret",
        ],
        [fallback],
      ),
    ).toEqual([
      expect.objectContaining({
        executablePath: "/opt/google/chrome/chrome",
        passwordStore: "gnome-libsecret",
        userDataDir: fallback.userDataDir,
      }),
    ]);
  });

  it("Profile 自动发现结果携带 Linux 主进程的 password store", async () => {
    const installation = await createUserData({ profiles: ["Default"] });
    installation.executablePaths = ["/opt/google/chrome/chrome"];

    await expect(
      discoverChromeProfile({
        platform: "linux",
        installations: [installation],
        processCommandLines: ["/opt/google/chrome/chrome --password-store=gnome-libsecret"],
      }),
    ).resolves.toMatchObject({
      success: true,
      source: {
        executablePath: "/opt/google/chrome/chrome",
        passwordStore: "gnome-libsecret",
        profilePath: join(installation.userDataDir, "Default"),
      },
    });
  });

  it("忽略未知 password store，避免把任意运行参数转发给 helper", () => {
    const installations = parseRunningChromeInstallations([
      "/usr/bin/google-chrome --user-data-dir=/home/demo/.config/google-chrome --password-store=unknown-backend",
    ]);

    expect(installations).toHaveLength(1);
    expect(installations[0]).not.toHaveProperty("passwordStore");
  });

  it("忽略 Electron/Chrome 的 crashpad 与 helper 子进程", () => {
    expect(
      parseRunningChromeInstallations([
        "/Applications/ZCode.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --user-data-dir=/tmp/zcode",
      ]),
    ).toEqual([]);
  });

  it("Windows 标准候选覆盖多渠道和 Program Files x86", () => {
    const installations = buildStandardChromeInstallations({
      platform: "win32",
      homeDir: "C:\\Users\\demo",
      localAppData: "C:\\Users\\demo\\AppData\\Local",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
    });

    expect(installations.map((item) => item.browser)).toEqual([
      "chrome",
      "chrome-beta",
      "chrome-dev",
      "chrome-canary",
      "chrome-for-testing",
      "chromium",
    ]);
    expect(installations[0]?.executablePaths.join("\n")).toContain("Program Files (x86)");
  });

  it("Linux 标准候选覆盖 XDG、Snap 与 Flatpak Profile", () => {
    const installations = buildStandardChromeInstallations({
      platform: "linux",
      homeDir: "/home/demo",
      env: {},
    });

    // Bugfix：buildStandardChromeInstallations 用宿主 path.join 拼 userDataDir，Windows 上
    // 分隔符是 `\`，而这里原来写死 POSIX 字面量，用例在 Windows 上必然失败。改用宿主 join
    // 组装期望值，断言仍然表达同一组「XDG / Snap / Flatpak 数据目录」。
    expect(installations.map(({ userDataDir }) => userDataDir)).toEqual(
      expect.arrayContaining([
        join("/home/demo", ".config", "google-chrome"),
        join("/home/demo", ".config", "chromium"),
        join("/home/demo", "snap", "chromium", "common", "chromium"),
        join("/home/demo", ".var/app/com.google.Chrome/config/google-chrome"),
        join("/home/demo", ".var/app/org.chromium.Chromium/config/chromium"),
      ]),
    );
    expect(
      installations.find(({ userDataDir }) => userDataDir.includes("com.google.Chrome"))
        ?.executablePaths,
    ).toContain("/var/lib/flatpak/exports/bin/com.google.Chrome");
  });

  it("优先使用环境变量显式指定的非默认 Chrome 路径", async () => {
    const executablePath = join(tempRoot, "custom", "chrome");
    await mkdir(join(tempRoot, "custom"), { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);

    await expect(
      resolveChromeExecutablePath({
        platform: "linux",
        env: { CHROME_PATH: executablePath, PATH: "" },
        installations: [],
        processCommandLines: [],
        registeredExecutablePaths: [],
      }),
    ).resolves.toBe(executablePath);
  });

  it("从运行中的 Chrome 主进程发现非默认可执行文件", async () => {
    const executablePath = join(tempRoot, "portable", "chrome");
    await mkdir(join(tempRoot, "portable"), { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);

    await expect(
      resolveChromeExecutablePath({
        platform: "linux",
        env: { PATH: "" },
        installations: [],
        processCommandLines: [`${executablePath} --no-first-run`],
        registeredExecutablePaths: [],
      }),
    ).resolves.toBe(executablePath);
  });

  it("从 Linux PATH 发现非默认目录中的 Chrome", async () => {
    const binDir = join(tempRoot, "bin");
    const executablePath = join(binDir, "google-chrome-stable");
    await mkdir(binDir, { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);

    await expect(
      resolveChromeExecutablePath({
        platform: "linux",
        env: { PATH: binDir },
        installations: [],
        processCommandLines: [],
        registeredExecutablePaths: [],
      }),
    ).resolves.toBe(executablePath);
  });

  it("从 Linux XDG desktop entry 发现非默认目录中的 Chrome", async () => {
    const executablePath = join(tempRoot, "apps", "chromium");
    const xdgDataHome = join(tempRoot, "share");
    const applicationsDir = join(xdgDataHome, "applications");
    await mkdir(join(tempRoot, "apps"), { recursive: true });
    await mkdir(applicationsDir, { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);
    await writeFile(
      join(applicationsDir, "custom-browser.desktop"),
      `[Desktop Entry]\nType=Application\nName=Chrome\nExec="${executablePath}" %U\n`,
    );

    await expect(
      resolveChromeExecutablePath({
        platform: "linux",
        env: {
          PATH: "",
          XDG_DATA_HOME: xdgDataHome,
          XDG_DATA_DIRS: join(tempRoot, "empty-share"),
        },
        homeDir: tempRoot,
        installations: [],
        processCommandLines: [],
      }),
    ).resolves.toBe(executablePath);
  });

  it("接受 macOS Spotlight 已解析出的非默认应用可执行文件", async () => {
    const executablePath = join(tempRoot, "Browsers", "Google Chrome");
    await mkdir(join(tempRoot, "Browsers"), { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);

    await expect(
      resolveChromeExecutablePath({
        platform: "darwin",
        env: {},
        installations: [],
        processCommandLines: [],
        registeredExecutablePaths: [executablePath],
      }),
    ).resolves.toBe(executablePath);
  });

  it("所有安全来源都没有 Chrome 时返回未找到", async () => {
    await expect(
      resolveChromeExecutablePath({
        platform: "linux",
        env: { PATH: "" },
        installations: [],
        processCommandLines: [],
        registeredExecutablePaths: [],
      }),
    ).resolves.toBeNull();
  });
});
