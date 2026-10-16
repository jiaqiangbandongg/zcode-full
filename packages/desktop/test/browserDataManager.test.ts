import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const lockedChromeSidecars = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    stat: async (path: Parameters<typeof actual.stat>[0]) =>
      lockedChromeSidecars.has(String(path))
        ? ({} as Awaited<ReturnType<typeof actual.stat>>)
        : actual.stat(path),
    copyFile: async (
      source: Parameters<typeof actual.copyFile>[0],
      destination: Parameters<typeof actual.copyFile>[1],
      mode?: Parameters<typeof actual.copyFile>[2],
    ) => {
      if (lockedChromeSidecars.has(String(source))) {
        throw Object.assign(new Error("Chrome sidecar is locked"), { code: "EBUSY" });
      }
      return actual.copyFile(source, destination, mode);
    },
  };
});

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
}));

import {
  clearEmbeddedBrowserData,
  importChromeBrowserData,
  resolveChromeDefaultProfilePath,
} from "../src/main/browserDataManager.js";
import {
  getEmbeddedBrowserSitePermissionSnapshot as snapshotSitePermissions,
  initEmbeddedBrowserSitePermissions,
  resetEmbeddedBrowserSitePermissionsForTest,
  writeEmbeddedBrowserSitePermission,
} from "../src/main/embeddedBrowserSitePermissions.js";
import {
  cleanupChromeHelperTempRoot,
  discoverChromeLocalStorageOrigins,
  importChromeLocalStorage,
} from "../src/main/chromeLocalStorageManager.js";
import { WindowsChromeAppBoundImportError } from "../src/main/windowsChromeAppBoundKey.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};
const localStorageResult = {
  originsImported: 2,
  entriesImported: 5,
  originsSkipped: 1,
  originsFailed: 0,
};
const localStorageImporter = vi.fn(async () => localStorageResult);

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-browser-data-test-"));
  lockedChromeSidecars.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function createChromeProfile(
  options: { encryptedValue?: Buffer; modernCookiePath?: boolean; value?: string } = {},
): string {
  const profilePath = join(tempRoot, "Default");
  const cookieDatabasePath = options.modernCookiePath
    ? join(profilePath, "Network", "Cookies")
    : join(profilePath, "Cookies");
  const cookieDatabase = new DatabaseSync(cookieDatabasePath);
  cookieDatabase.exec(`
    CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta (key, value) VALUES ('version', '23');
    CREATE TABLE cookies (
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL
    );
  `);
  cookieDatabase
    .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "example.com",
      "session",
      "/",
      0n,
      1n,
      1n,
      1n,
      options.value ?? "fixture-value",
      options.encryptedValue ?? Buffer.alloc(0),
    );
  cookieDatabase.close();

  return profilePath;
}

function encryptLinuxV10Cookie(value: string): Buffer {
  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
}

function createFailingSourceBackup(): {
  databaseBackup: typeof backup;
  getCallCount: () => number;
} {
  let callCount = 0;
  return {
    databaseBackup: async (sourceDatabase, destination, options) => {
      callCount += 1;
      if (callCount === 1) {
        throw Object.assign(new Error("source WAL lock unavailable"), {
          code: "ERR_SQLITE_ERROR",
        });
      }
      return options
        ? backup(sourceDatabase, destination, options)
        : backup(sourceDatabase, destination);
    },
    getCallCount: () => callCount,
  };
}

function encryptWindowsCookieV20(value: string, key: Buffer): Buffer {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v20"), nonce, ciphertext, cipher.getAuthTag()]);
}

describe("browserDataManager", () => {
  it("Chrome helper 临时目录清理失败时不覆盖已读取结果", async () => {
    const cleanupError = Object.assign(new Error("directory is not empty"), {
      code: "ENOTEMPTY",
    });
    const remover = vi.fn(async () => {
      throw cleanupError;
    });

    await expect(
      cleanupChromeHelperTempRoot({ tempRoot, logger, remover }),
    ).resolves.toBeUndefined();

    expect(remover).toHaveBeenCalledWith(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    expect(logger.warn).toHaveBeenCalledWith("[browser-data] Chrome helper 临时目录清理失败", {
      name: "Error",
      code: "ENOTEMPTY",
    });
  });

  it("使用 createRequire 加载 node:sqlite，避免桌面 bundle 丢失 node: 前缀", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../src/main/chromeCookieManager.ts"),
      "utf8",
    );

    expect(source).toMatch(/nodeRequire\(\s*"node:sqlite",?\s*\)/);
    expect(source).not.toContain('await import("node:sqlite")');
  });

  it("按操作系统定位 Chrome Default Profile", () => {
    // Bugfix：resolveChromeDefaultProfilePath 用宿主 path.join 拼接，Windows 上分隔符是 `\`，
    // 而这里原来写死 POSIX 字面量，三条断言在 Windows 上都对不上。改用宿主 join 组装期望值，
    // 断言仍然表达同一个「各系统 Chrome Default Profile 布局」。
    expect(
      resolveChromeDefaultProfilePath({
        platform: "darwin",
        homeDir: "/Users/demo",
      }),
    ).toBe(join("/Users/demo", "Library", "Application Support", "Google", "Chrome", "Default"));
    expect(
      resolveChromeDefaultProfilePath({
        platform: "win32",
        homeDir: "C:\\Users\\demo",
        localAppData: "C:\\Users\\demo\\AppData\\Local",
      }),
    ).toContain(join("Google", "Chrome", "User Data", "Default"));
    expect(
      resolveChromeDefaultProfilePath({
        platform: "linux",
        homeDir: "/home/demo",
      }),
    ).toBe(join("/home/demo", ".config", "google-chrome", "Default"));
  });

  it("一键导入 Default Profile 的明文 Cookie", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile();
    const set = vi.fn(async () => {});
    const flushStore = vi.fn(async () => {});
    const targetSession = {
      clearCache: vi.fn(async () => {}),
      clearStorageData: vi.fn(async () => {}),
      cookies: { set, flushStore },
    };
    const importedAt = Math.floor(Date.now() / 1000);

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      profilePath,
      targetSession,
      localStorageImporter,
    });

    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 1, skipped: 0, failed: 0 },
      localStorage: localStorageResult,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/",
        name: "session",
        value: "fixture-value",
        httpOnly: true,
        sameSite: "lax",
        expirationDate: expect.any(Number),
      }),
    );
    const cookieDetails = set.mock.calls[0]?.[0];
    expect(cookieDetails?.expirationDate).toBeGreaterThan(importedAt + 399 * 24 * 60 * 60);
    expect(flushStore).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("[browser-data] Chrome Cookie 写入完成", {
      importedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it("兼容新版 Chrome 的 Network/Cookies 数据库路径", async () => {
    await mkdir(join(tempRoot, "Default", "Network"), { recursive: true });
    const profilePath = createChromeProfile({ modernCookiePath: true });
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      profilePath,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(result.success).toBe(true);
    expect(set).toHaveBeenCalledOnce();
  });

  it("在线备份失败后不复制 Windows 可能锁定的 SHM", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile();
    const cookieDatabasePath = join(profilePath, "Cookies");
    // Windows 的占用锁无法在非 Windows CI 精确构造；这里让文件系统报告 SHM
    // 存在且 copyFile 返回 EBUSY，证明 fallback 只复制持久化主库/WAL。
    lockedChromeSidecars.add(`${cookieDatabasePath}-shm`);
    const failingBackup = createFailingSourceBackup();
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      chromeCookieDatabaseBackup: failingBackup.databaseBackup,
      logger,
      platform: "linux",
      profilePath,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(result.success).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    expect(failingBackup.getCallCount()).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Chrome Cookie 在线备份不可用，回退 WAL 文件快照",
      { name: "Error", code: "ERR_SQLITE_ERROR" },
    );
  });

  it("在线备份失败后从文件快照保留 Chrome WAL 中已提交的 Cookie", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile();
    const database = new DatabaseSync(join(profilePath, "Cookies"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    database
      .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("wal.example.com", "wal-session", "/", 0n, 1n, 0n, 0n, "wal-value", Buffer.alloc(0));
    const failingBackup = createFailingSourceBackup();
    const set = vi.fn(async () => {});

    try {
      const result = await importChromeBrowserData({
        chromeCookieDatabaseBackup: failingBackup.databaseBackup,
        logger,
        platform: "linux",
        profilePath,
        localStorageImporter,
        targetSession: {
          clearCache: vi.fn(async () => {}),
          clearStorageData: vi.fn(async () => {}),
          cookies: { set, flushStore: vi.fn(async () => {}) },
        },
      });

      expect(result).toMatchObject({
        success: true,
        cookies: { imported: 2, skipped: 0, failed: 0 },
      });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ name: "wal-session", value: "wal-value" }),
      );
      expect(failingBackup.getCallCount()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("Chrome Profile 不存在时返回可操作错误", async () => {
    const result = await importChromeBrowserData({
      logger,
      profilePath: join(tempRoot, "missing"),
    });

    expect(result).toMatchObject({
      success: false,
      error: "chrome_profile_not_found",
      cookies: { imported: 0 },
    });
  });

  it("macOS/Linux 未安装 Chrome 时在 Profile 发现前停止导入", async () => {
    const chromeExecutableDiscovery = vi.fn(async () => null);
    const chromeProfileDiscovery = vi.fn(async () => ({
      success: false as const,
      error: "chrome_profile_not_found" as const,
    }));

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      chromeExecutableDiscovery,
      chromeProfileDiscovery,
    });

    expect(result).toMatchObject({
      success: false,
      error: "chrome_executable_not_found",
      cookies: { imported: 0 },
    });
    expect(chromeExecutableDiscovery).toHaveBeenCalledOnce();
    expect(chromeProfileDiscovery).not.toHaveBeenCalled();
    expect(localStorageImporter).not.toHaveBeenCalled();
  });

  it("Profile 自动发现无法消歧时不修改目标 session", async () => {
    const result = await importChromeBrowserData({
      logger,
      // 该用例只验证 profile 消歧失败；显式注入 executable，避免依赖测试机是否安装 Chrome。
      chromeExecutableDiscovery: async () => "/usr/bin/google-chrome",
      chromeProfileDiscovery: async () => ({
        success: false,
        error: "chrome_profile_ambiguous",
      }),
    });

    expect(result).toMatchObject({
      success: false,
      error: "chrome_profile_ambiguous",
      cookies: { imported: 0 },
    });
  });

  it("macOS 用户拒绝钥匙串授权后终止整次导入", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v10"), Buffer.alloc(48, 1)]),
    });
    const set = vi.fn(async () => {});
    const flushStore = vi.fn(async () => {});
    const deniedError = Object.assign(new Error("User canceled the operation"), { code: 128 });
    const macChromeSafeStorageSecretReader = vi.fn(async () => {
      throw deniedError;
    });

    const result = await importChromeBrowserData({
      logger,
      platform: "darwin",
      profilePath,
      macChromeSafeStorageSecretReader,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore },
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: "chrome_cookie_access_denied",
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
    });
    expect(macChromeSafeStorageSecretReader).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
    expect(localStorageImporter).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Chrome 数据导入已取消：macOS 钥匙串授权被拒绝",
    );
  });

  it("Linux v10 Cookie 继续在本进程解密，不启动 Chrome helper", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: encryptLinuxV10Cookie("linux-v10-value"),
    });
    const chromeCookieHelper = vi.fn(async () => []);
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      profilePath,
      chromeExecutablePath: "/usr/bin/google-chrome",
      chromeCookieHelper,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 1, skipped: 0, failed: 0 },
    });
    expect(chromeCookieHelper).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ value: "linux-v10-value" }));
  });

  it("Linux v11 Cookie 由同品牌 Chrome helper 解密并转发 KWallet 后端", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v11"), Buffer.alloc(48, 1)]),
    });
    const chromeCookieHelper = vi.fn(async () => [
      {
        domain: ".example.com",
        expires: 0,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "Lax" as const,
        secure: true,
        session: true,
        value: "linux-v11-value",
      },
    ]);
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      // Bugfix：这条用例既不传 profilePath 也不传 chromeExecutablePath，
      // importChromeBrowserData 会先做可执行文件发现（browserDataManager.ts:124），
      // 在非 Linux 宿主上探测不到 /usr/bin/google-chrome，直接以
      // chrome_executable_not_found 返回，chromeProfileDiscovery 根本不会被调用，
      // helper 断言只能看到 0 次调用。这里注入发现结果，让用例只考察
      // 「v11 Cookie 交给同品牌 helper 并转发 KWallet 后端」这一件事，不依赖宿主是否装了 Chrome。
      chromeExecutableDiscovery: async () => "/usr/bin/google-chrome",
      chromeProfileDiscovery: async () => ({
        success: true,
        source: {
          browser: "chrome",
          executablePath: "/usr/bin/google-chrome",
          passwordStore: "kwallet6",
          profileDirectory: "Default",
          profilePath,
          userDataDir: tempRoot,
        },
      }),
      chromeCookieHelper,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(chromeCookieHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "/usr/bin/google-chrome",
        passwordStore: "kwallet6",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 1, skipped: 0, failed: 0 },
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ value: "linux-v11-value" }));
  });

  it("Linux v11 helper 不可用时保留 LocalStorage 并返回保护提示", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v11"), Buffer.alloc(48, 1)]),
    });

    const result = await importChromeBrowserData({
      logger,
      platform: "linux",
      profilePath,
      chromeExecutablePath: "/usr/bin/google-chrome",
      chromeCookieHelper: vi.fn(async () => {
        throw new Error("keyring unavailable");
      }),
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: {
          set: vi.fn(async () => {}),
          flushStore: vi.fn(async () => {}),
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 0, skipped: 1 },
      localStorage: localStorageResult,
      issues: expect.arrayContaining(["chrome_cookie_protection_unsupported"]),
    });
  });

  it("Windows v20 Cookie 在本次管理员授权后由原生 helper 解密", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const masterKey = Buffer.alloc(32, 9);
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: encryptWindowsCookieV20("helper-value", masterKey),
    });
    const helperResult = Buffer.from(masterKey);
    const windowsChromeAppBoundKeyReader = vi.fn(async () => helperResult);
    const failingBackup = createFailingSourceBackup();
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      allowElevatedChromeDecryption: true,
      chromeCookieDatabaseBackup: failingBackup.databaseBackup,
      logger,
      platform: "win32",
      profilePath,
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      windowsChromeAppBoundKeyReader,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(windowsChromeAppBoundKeyReader).toHaveBeenCalledOnce();
    expect(failingBackup.getCallCount()).toBe(2);
    expect(windowsChromeAppBoundKeyReader).toHaveBeenCalledWith(
      expect.objectContaining({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        userDataDir: tempRoot,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 1, skipped: 0, failed: 0 },
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ value: "helper-value", url: "https://example.com/" }),
    );
    expect(helperResult.every((value) => value === 0)).toBe(true);
  });

  it("Windows v20 helper 不可用时保留 LocalStorage 并返回稳定错误", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v20"), Buffer.alloc(48, 1)]),
    });

    const result = await importChromeBrowserData({
      allowElevatedChromeDecryption: true,
      logger,
      platform: "win32",
      profilePath,
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      windowsChromeAppBoundKeyReader: vi.fn(async () => {
        throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
      }),
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: {
          set: vi.fn(async () => {}),
          flushStore: vi.fn(async () => {}),
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 0, skipped: 1 },
      localStorage: localStorageResult,
      issues: expect.arrayContaining(["chrome_cookie_helper_verification_failed"]),
    });
  });

  it("Windows v20 授权失败时整批 Cookie 都不写入", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v20"), Buffer.alloc(48, 1)]),
    });
    const cookieDatabase = new DatabaseSync(join(profilePath, "Cookies"));
    cookieDatabase
      .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("plain.example.com", "plain", "/", 0n, 1n, 1n, 1n, "plain-value", Buffer.alloc(0));
    cookieDatabase.close();
    const set = vi.fn(async () => {});

    const result = await importChromeBrowserData({
      allowElevatedChromeDecryption: true,
      logger,
      platform: "win32",
      profilePath,
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      windowsChromeAppBoundKeyReader: vi.fn(async () => {
        throw new WindowsChromeAppBoundImportError("chrome_cookie_elevation_cancelled");
      }),
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set, flushStore: vi.fn(async () => {}) },
      },
    });

    expect(set).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 0, skipped: 2, failed: 0 },
      localStorage: localStorageResult,
      issues: expect.arrayContaining(["chrome_cookie_elevation_cancelled"]),
    });
  });

  it("Windows 未获得本次确认时不启动 helper，但仍可导入 LocalStorage", async () => {
    await mkdir(join(tempRoot, "Default"), { recursive: true });
    const profilePath = createChromeProfile({
      value: "",
      encryptedValue: Buffer.concat([Buffer.from("v20"), Buffer.alloc(48, 1)]),
    });
    const windowsChromeAppBoundKeyReader = vi.fn(async () => Buffer.alloc(32));

    const result = await importChromeBrowserData({
      logger,
      platform: "win32",
      profilePath,
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      windowsChromeAppBoundKeyReader,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) },
      },
    });

    expect(windowsChromeAppBoundKeyReader).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      localStorage: localStorageResult,
      issues: expect.arrayContaining(["chrome_cookie_elevation_required"]),
    });
  });

  it("没有 Cookie 数据库时仍可只导入 LocalStorage", async () => {
    const profilePath = join(tempRoot, "Default");
    await mkdir(profilePath, { recursive: true });

    const result = await importChromeBrowserData({
      logger,
      profilePath,
      localStorageImporter,
      targetSession: {
        clearCache: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        cookies: {
          set: vi.fn(async () => {}),
          flushStore: vi.fn(async () => {}),
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      cookies: { imported: 0 },
      localStorage: localStorageResult,
    });
  });

  it("只从 Chrome LocalStorage metadata key 发现 HTTP(S) origin", async () => {
    const localStoragePath = join(tempRoot, "Local Storage");
    const levelDbPath = join(localStoragePath, "leveldb");
    await mkdir(levelDbPath, { recursive: true });
    await writeFile(
      join(levelDbPath, "000001.ldb"),
      Buffer.from(
        "binary\0META:https://chat.z.ai\0META:http://localhost:3000\0META:chrome-extension://ignored",
        "latin1",
      ),
    );

    await expect(discoverChromeLocalStorageOrigins(localStoragePath)).resolves.toEqual([
      "http://localhost:3000",
      "https://chat.z.ai",
    ]);
  });

  it("先复制 LocalStorage 快照，再从快照发现 origin", async () => {
    const profilePath = join(tempRoot, "Default");
    const levelDbPath = join(profilePath, "Local Storage", "leveldb");
    await mkdir(levelDbPath, { recursive: true });
    await writeFile(
      join(levelDbPath, "000001.ldb"),
      Buffer.from("binary\0META:https://chat.z.ai", "latin1"),
    );

    const result = await importChromeLocalStorage({
      profilePath,
      platform: "aix",
      logger,
      targetSession: {} as Electron.Session,
    });

    expect(result).toMatchObject({
      originsImported: 0,
      originsFailed: 1,
      error: "chrome_executable_not_found",
    });
  });

  it("普通清理保留 Cookie，全量清理使用 Electron 全存储清理", async () => {
    const clearCache = vi.fn(async () => {});
    const clearStorageData = vi.fn(async () => {});
    const targetSession = {
      clearCache,
      clearStorageData,
      cookies: {
        set: vi.fn(async () => {}),
        flushStore: vi.fn(async () => {}),
      },
    };

    await clearEmbeddedBrowserData({ logger, mode: "cache", targetSession });
    expect(clearStorageData).toHaveBeenNthCalledWith(1, {
      storages: ["shadercache", "serviceworkers", "cachestorage"],
    });

    await clearEmbeddedBrowserData({ logger, mode: "all", targetSession });
    expect(clearStorageData).toHaveBeenNthCalledWith(2);
    expect(clearCache).toHaveBeenCalledTimes(2);
  });

  it("全量清理同时清空站点权限同意记录，普通清理保留", async () => {
    const clearCache = vi.fn(async () => {});
    const clearStorageData = vi.fn(async () => {});
    const targetSession = {
      clearCache,
      clearStorageData,
      cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) },
    };
    resetEmbeddedBrowserSitePermissionsForTest();
    await initEmbeddedBrowserSitePermissions({ logger });
    await writeEmbeddedBrowserSitePermission("https://example.com", "media", "allow");

    await clearEmbeddedBrowserData({ logger, mode: "cache", targetSession });
    expect(snapshotSitePermissions()).toEqual({
      "https://example.com": { media: "allow" },
    });

    await clearEmbeddedBrowserData({ logger, mode: "all", targetSession });
    expect(snapshotSitePermissions()).toEqual({});
    resetEmbeddedBrowserSitePermissionsForTest();
  });
});
