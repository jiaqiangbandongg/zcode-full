/* eslint-disable max-lines */
// 安全说明：Cookie 快照、跨平台解密选择与整批写入必须留在同一事务审计边界，
// 避免拆分后让 Windows App-Bound 原子失败语义与 Linux helper 回退顺序发生漂移。
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ChromeBrowserDataImportError } from "@zcode/shared";
import { readChromeCookiesWithHelper } from "./chromeLocalStorageManager.js";
import {
  toCookieDetails,
  toCookieDetailsFromHelper,
  type ChromeCookieRow,
} from "./chromeCookieMapping.js";
import {
  ChromeCookieAccessDeniedError,
  readMacChromeSafeStorageSecret,
  readWindowsChromeMasterKey,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import {
  readWindowsChromeAppBoundKey,
  WindowsChromeAppBoundImportError,
  type WindowsChromeAppBoundKeyReader,
} from "./windowsChromeAppBoundKey.js";

const nodeRequire = createRequire(import.meta.url);
// tsup/esbuild 会把动态 import("node:sqlite") 错误改写为 import("sqlite")，
// Electron 运行时因此报 ERR_MODULE_NOT_FOUND。createRequire 能稳定保留 node: 协议。
const { DatabaseSync, backup } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const COOKIE_IMPORT_CONCURRENCY = 32;
const DATABASE_SNAPSHOT_COPY_ATTEMPTS = 3;

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface CookieTargetSession {
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

type CookieDecryptor = (encrypted: Uint8Array, hostKey: string, schemaVersion: number) => string;
export type ChromeCookieHelper = typeof readChromeCookiesWithHelper;
export type ChromeCookieDatabaseBackup = typeof backup;

interface CookieDecryptorResource {
  decrypt: CookieDecryptor;
  dispose(): void;
}

export interface ChromeCookieImportResult {
  databaseFound: boolean;
  issues: ChromeBrowserDataImportError[];
  rowCount: number;
  stats: {
    imported: number;
    skipped: number;
    failed: number;
  };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

function stripChromeHostDigest(value: Buffer, schemaVersion: number): Buffer {
  // Chrome Cookie schema 24+ 在加密明文前附加 SHA-256(host_key)；这里只移除固定长度摘要。
  return schemaVersion >= 24 && value.length >= 32 ? value.subarray(32) : value;
}

function createCbcDecryptor(secret: string, iterations: number): CookieDecryptorResource {
  const key = pbkdf2Sync(secret, "saltysalt", iterations, 16, "sha1");
  return {
    decrypt: (encrypted, _hostKey, schemaVersion) => {
      const buffer = Buffer.from(encrypted);
      if (buffer.subarray(0, 3).toString("ascii") !== "v10") {
        throw new Error("chrome_cookie_encryption_unsupported");
      }
      const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      const decrypted = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
      try {
        return stripChromeHostDigest(decrypted, schemaVersion).toString("utf8");
      } finally {
        decrypted.fill(0);
      }
    },
    dispose: () => key.fill(0),
  };
}

function createWindowsGcmDecryptor(
  masterKey: Buffer,
  acceptedPrefixes: ReadonlySet<string>,
): CookieDecryptorResource {
  return {
    decrypt: (encrypted, _hostKey, schemaVersion) => {
      const buffer = Buffer.from(encrypted);
      const prefix = buffer.subarray(0, 3).toString("ascii");
      if (!acceptedPrefixes.has(prefix)) {
        throw new Error("chrome_cookie_encryption_unsupported");
      }
      const nonce = buffer.subarray(3, 15);
      const authTag = buffer.subarray(buffer.length - 16);
      const ciphertext = buffer.subarray(15, buffer.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return stripChromeHostDigest(decrypted, schemaVersion).toString("utf8");
      } finally {
        decrypted.fill(0);
      }
    },
    dispose: () => masterKey.fill(0),
  };
}

async function createCookieDecryptor(
  platform: NodeJS.Platform,
  profilePath: string,
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader,
): Promise<CookieDecryptorResource> {
  if (platform === "darwin") {
    return createCbcDecryptor(
      await readMacChromeSafeStorageSecret(macChromeSafeStorageSecretReader),
      1003,
    );
  }
  if (platform === "win32") {
    return createWindowsGcmDecryptor(
      await readWindowsChromeMasterKey(dirname(profilePath)),
      new Set(["v10", "v11"]),
    );
  }
  return createCbcDecryptor("peanuts", 1);
}

async function withDatabaseSnapshot<T>(
  sourcePath: string,
  logger: BrowserDataLogger,
  databaseBackup: ChromeCookieDatabaseBackup,
  run: (snapshotPath: string) => T | Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-browser-import-"));
  const snapshotPath = join(tempDir, "database.sqlite");
  let sourceDatabase: import("node:sqlite").DatabaseSync | null = null;
  try {
    try {
      sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
      await databaseBackup(sourceDatabase, snapshotPath);
      sourceDatabase.close();
      sourceDatabase = null;
    } catch (onlineBackupError) {
      sourceDatabase?.close();
      sourceDatabase = null;
      logger.warn(
        "[browser-data] Chrome Cookie 在线备份不可用，回退 WAL 文件快照",
        toSafeBrowserDataError(onlineBackupError),
      );

      let fallbackError: unknown = onlineBackupError;
      for (let attempt = 1; attempt <= DATABASE_SNAPSHOT_COPY_ATTEMPTS; attempt += 1) {
        const stagedPath = join(tempDir, `source-${attempt}.sqlite`);
        let stagedDatabase: import("node:sqlite").DatabaseSync | null = null;
        try {
          await rm(snapshotPath, { force: true });
          await copyFile(sourcePath, stagedPath);
          const sourceWalPath = `${sourcePath}-wal`;
          if (await pathExists(sourceWalPath)) {
            await copyFile(sourceWalPath, `${stagedPath}-wal`);
          }
          // Chrome 的 SHM 仅用于并发协调且在 Windows 上可能被独占锁定。
          // 临时目录中的 SQLite 会自行重建 SHM，再通过 Online Backup 固化并校验主库与 WAL。
          stagedDatabase = new DatabaseSync(stagedPath, { readOnly: true });
          await databaseBackup(stagedDatabase, snapshotPath);
          stagedDatabase.close();
          stagedDatabase = null;
          logger.info("[browser-data] Chrome Cookie WAL 文件快照完成", { attempt });
          fallbackError = null;
          break;
        } catch (error) {
          fallbackError = error;
        } finally {
          stagedDatabase?.close();
          await rm(stagedPath, { force: true });
          await rm(`${stagedPath}-wal`, { force: true });
          await rm(`${stagedPath}-shm`, { force: true });
        }
      }
      if (fallbackError) {
        logger.warn(
          "[browser-data] Chrome Cookie WAL 文件快照失败",
          toSafeBrowserDataError(fallbackError),
        );
        throw fallbackError;
      }
    }
    return await run(snapshotPath);
  } finally {
    // TypeScript 会把前面显式置空后的 finally 路径收窄成 never，
    // 但 SQLite backup 在异常边界仍可能留下句柄；保留运行时兜底并显式恢复实际联合类型。
    const danglingDatabase = sourceDatabase as import("node:sqlite").DatabaseSync | null;
    danglingDatabase?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readChromeCookies(databasePath: string): Promise<{
  rows: ChromeCookieRow[];
  schemaVersion: number;
}> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versionRow = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value?: string }
      | undefined;
    const statement = database.prepare(
      "SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, value, encrypted_value FROM cookies",
    );
    statement.setReadBigInts(true);
    return {
      rows: statement.all() as unknown as ChromeCookieRow[],
      schemaVersion: Number(versionRow?.value ?? 0),
    };
  } finally {
    database.close();
  }
}

async function resolveChromeCookieDatabasePath(profilePath: string): Promise<string | null> {
  for (const candidate of [join(profilePath, "Network", "Cookies"), join(profilePath, "Cookies")]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function hasEncryptedCookiePrefix(rows: ChromeCookieRow[], prefix: "v11" | "v20"): boolean {
  return rows.some(
    (row) => Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii") === prefix,
  );
}

async function collectCookieDetails(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieHelper: ChromeCookieHelper;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  cookieDatabasePath: string;
  cookieDatabaseRelativePath: string;
  importedAt: number;
  issues: Set<ChromeBrowserDataImportError>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  platform: NodeJS.Platform;
  profilePath: string;
  rows: ChromeCookieRow[];
  schemaVersion: number;
  windowsChromeAppBoundKeyReader: WindowsChromeAppBoundKeyReader;
}): Promise<{ details: Electron.CookiesSetDetails[]; skipped: number }> {
  if (options.platform === "linux" && hasEncryptedCookiePrefix(options.rows, "v11")) {
    if (options.chromeExecutablePath) {
      try {
        const helperCookies = await options.chromeCookieHelper({
          cookieDatabasePath: options.cookieDatabasePath,
          cookieDatabaseRelativePath: options.cookieDatabaseRelativePath,
          executablePath: options.chromeExecutablePath,
          logger: options.logger,
          ...(options.platform === "linux" && options.chromePasswordStore
            ? { passwordStore: options.chromePasswordStore }
            : {}),
          profilePath: options.profilePath,
        });
        if (helperCookies.length > 0 || options.rows.length === 0) {
          options.logger.info("[browser-data] Chrome helper Cookie 快照读取完成", {
            returnedCount: helperCookies.length,
            reason: "linux-keyring-v11",
          });
          return {
            details: helperCookies.map((cookie) =>
              toCookieDetailsFromHelper(cookie, options.importedAt),
            ),
            skipped: Math.max(0, options.rows.length - helperCookies.length),
          };
        }
      } catch (error) {
        options.logger.warn("[browser-data] Chrome Cookie helper 不可用", {
          reason: "linux-keyring-v11",
          ...toSafeBrowserDataError(error),
        });
      }
    } else {
      options.issues.add("chrome_executable_not_found");
    }
    // Linux v11 绑定系统密钥环；同品牌 Chrome helper 不可用时，只能继续尝试
    // 当前进程可安全解密的旧格式，不能绕过系统密钥保护。
    options.issues.add("chrome_cookie_protection_unsupported");
  }

  let appBoundDecryptor: CookieDecryptorResource | null = null;
  const containsAppBoundCookie =
    options.platform === "win32" && hasEncryptedCookiePrefix(options.rows, "v20");
  if (containsAppBoundCookie) {
    if (!options.allowElevatedChromeDecryption) {
      options.issues.add("chrome_cookie_elevation_required");
    } else if (options.chromeExecutablePath) {
      try {
        const key = await options.windowsChromeAppBoundKeyReader({
          chromeExecutablePath: options.chromeExecutablePath,
          logger: options.logger,
          userDataDir: dirname(options.profilePath),
        });
        appBoundDecryptor = createWindowsGcmDecryptor(key, new Set(["v20"]));
        options.logger.info("[browser-data] Chrome App-Bound 解密材料已就绪");
      } catch (error) {
        const issue =
          error instanceof WindowsChromeAppBoundImportError
            ? error.code
            : "chrome_cookie_app_bound_decryption_failed";
        options.issues.add(issue);
        options.logger.warn(
          "[browser-data] Chrome App-Bound Cookie 原生解密失败",
          toSafeBrowserDataError(error),
        );
      }
    } else {
      options.issues.add("chrome_executable_not_found");
    }

    if (!appBoundDecryptor) {
      // 同一 Chrome 数据库可能同时包含明文、旧版和 v20 Cookie。
      // App-Bound 授权失败时 Cookie 阶段必须保持原子性，不能悄悄写入同批的普通 Cookie。
      return { details: [], skipped: options.rows.length };
    }
  }

  let legacyDecryptor: CookieDecryptorResource | null = null;
  const needsLegacyDecryptor = options.rows.some((row) => {
    if (row.value || row.encrypted_value.length === 0) return false;
    return Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii") !== "v20";
  });
  if (needsLegacyDecryptor) {
    try {
      legacyDecryptor = await createCookieDecryptor(
        options.platform,
        options.profilePath,
        options.macChromeSafeStorageSecretReader,
      );
    } catch (error) {
      if (error instanceof ChromeCookieAccessDeniedError) throw error;
      options.issues.add("chrome_cookie_protection_unsupported");
      options.logger.warn("[browser-data] Chrome Cookie 系统解密材料不可用");
    }
  }

  const details: Electron.CookiesSetDetails[] = [];
  let skipped = 0;
  let protectedCookieSkipped = false;
  try {
    for (const row of options.rows) {
      let value = row.value;
      if (!value && row.encrypted_value.length > 0) {
        const prefix = Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii");
        const decryptor = prefix === "v20" ? appBoundDecryptor : legacyDecryptor;
        if (!decryptor) {
          skipped += 1;
          protectedCookieSkipped = true;
          continue;
        }
        try {
          value = decryptor.decrypt(row.encrypted_value, row.host_key, options.schemaVersion);
        } catch {
          skipped += 1;
          protectedCookieSkipped = true;
          continue;
        }
      }
      if (!value) {
        skipped += 1;
        continue;
      }
      details.push(toCookieDetails(row, value, options.importedAt));
    }
  } finally {
    appBoundDecryptor?.dispose();
    legacyDecryptor?.dispose();
  }
  if (protectedCookieSkipped && options.issues.size === 0) {
    options.issues.add("chrome_cookie_protection_unsupported");
  }
  return { details, skipped };
}

export async function importChromeCookies(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieHelper?: ChromeCookieHelper;
  databaseBackup?: ChromeCookieDatabaseBackup;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  platform: NodeJS.Platform;
  profilePath: string;
  targetSession: CookieTargetSession;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
}): Promise<ChromeCookieImportResult> {
  const cookieDatabasePath = await resolveChromeCookieDatabasePath(options.profilePath);
  if (!cookieDatabasePath) {
    return {
      databaseFound: false,
      issues: [],
      rowCount: 0,
      stats: { imported: 0, skipped: 0, failed: 0 },
    };
  }
  const cookieDatabaseRelativePath = relative(options.profilePath, cookieDatabasePath);
  return withDatabaseSnapshot(
    cookieDatabasePath,
    options.logger,
    options.databaseBackup ?? backup,
    async (snapshotPath) => {
      const { rows, schemaVersion } = await readChromeCookies(snapshotPath);
      options.logger.info("[browser-data] Chrome Cookie 快照读取完成", {
        sourceCount: rows.length,
      });
      const issues = new Set<ChromeBrowserDataImportError>();
      const collected = await collectCookieDetails({
        allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
        chromeCookieHelper: options.chromeCookieHelper ?? readChromeCookiesWithHelper,
        chromeExecutablePath: options.chromeExecutablePath,
        chromePasswordStore: options.chromePasswordStore,
        cookieDatabasePath: snapshotPath,
        cookieDatabaseRelativePath,
        importedAt: Math.floor(Date.now() / 1000),
        issues,
        logger: options.logger,
        macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
        platform: options.platform,
        profilePath: options.profilePath,
        rows,
        schemaVersion,
        windowsChromeAppBoundKeyReader:
          options.windowsChromeAppBoundKeyReader ?? readWindowsChromeAppBoundKey,
      });
      const stats = { imported: 0, skipped: collected.skipped, failed: 0 };
      for (let offset = 0; offset < collected.details.length; offset += COOKIE_IMPORT_CONCURRENCY) {
        const batch = collected.details.slice(offset, offset + COOKIE_IMPORT_CONCURRENCY);
        const statuses = await Promise.allSettled(
          batch.map((details) => options.targetSession.cookies.set(details)),
        );
        for (const status of statuses) {
          if (status.status === "fulfilled") stats.imported += 1;
          else stats.failed += 1;
        }
      }
      await options.targetSession.cookies.flushStore();
      options.logger.info("[browser-data] Chrome Cookie 写入完成", {
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        failedCount: stats.failed,
      });
      return { databaseFound: true, issues: [...issues], rowCount: rows.length, stats };
    },
  );
}
