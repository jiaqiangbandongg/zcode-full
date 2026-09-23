import { createHash } from "node:crypto";
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import type {
  GitBackupConfig,
  GitBackupManifest,
  GitBackupManifestEntry,
  GitBackupStatus,
  IGitBackupService,
} from "./gitBackup.js";
import {
  ensureKeyPair,
  encryptBuffer,
  readPublicKey,
  readPrivateKey,
} from "./gitBackupEncryption.js";
import { uploadToOss } from "./gitBackupOssClient.js";

const CONFIG_FILE = "git-backup-config.json";
const ONBOARDING_FLAG = "git-backup-onboarding-done";

function getConfigPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE);
}

function getOnboardingPath(dataDir: string): string {
  return join(dataDir, ONBOARDING_FLAG);
}

const DEFAULT_CONFIG: GitBackupConfig = {
  enabled: false,
  intervalMinutes: 60,
  oss: null,
};

async function loadConfig(dataDir: string): Promise<GitBackupConfig> {
  const configPath = getConfigPath(dataDir);
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = await readFile(configPath, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

async function saveConfig(dataDir: string, config: GitBackupConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(getConfigPath(dataDir), JSON.stringify(config, null, 2), "utf-8");
}

async function collectGitFiles(gitDir: string): Promise<GitBackupManifestEntry[]> {
  const entries: GitBackupManifestEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const fileStat = await stat(fullPath);
        const content = await readFile(fullPath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        entries.push({
          path: relative(gitDir, fullPath),
          size: fileStat.size,
          sha256,
        });
      }
    }
  }

  await walk(gitDir);
  return entries;
}

async function packGitDir(gitDir: string): Promise<Buffer> {
  const entries = await readdir(gitDir, { withFileTypes: true, recursive: true });
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Node 24 已移除 Dirent.path，parentPath 始终存在，去掉对 path 的兜底（否则类型检查报错）。
    const fullPath = join(entry.parentPath, entry.name);
    const relPath = relative(gitDir, fullPath);
    const content = await readFile(fullPath);
    const header = Buffer.from(`${relPath}\0${content.length}\0`);
    chunks.push(header, content);
  }

  return Buffer.concat(chunks);
}

export function createGitBackupService(dataDir: string): IGitBackupService {
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  let lastStatus: Partial<GitBackupStatus> = {};

  function clearScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  return {
    async configure(partial) {
      const current = await loadConfig(dataDir);
      const updated = { ...current, ...partial };

      if (!updated.enabled) {
        clearScheduler();
      }

      await saveConfig(dataDir, updated);
    },

    async getConfig() {
      return loadConfig(dataDir);
    },

    async getStatus(): Promise<GitBackupStatus> {
      const config = await loadConfig(dataDir);
      return {
        enabled: config.enabled,
        configured: config.oss !== null,
        lastBackupAt: lastStatus.lastBackupAt ?? null,
        lastBackupFiles: lastStatus.lastBackupFiles ?? 0,
        lastBackupSize: lastStatus.lastBackupSize ?? 0,
        nextBackupAt: lastStatus.nextBackupAt ?? null,
        running: lastStatus.running ?? false,
        error: lastStatus.error ?? null,
      };
    },

    async startBackup(workspacePath: string): Promise<GitBackupManifest> {
      const config = await loadConfig(dataDir);
      if (!config.oss) {
        throw new Error(
          "OSS not configured. Please configure your Alibaba Cloud OSS credentials first.",
        );
      }

      lastStatus.running = true;
      lastStatus.error = null;

      try {
        const gitDir = join(workspacePath, ".git");
        if (!existsSync(gitDir)) {
          throw new Error(`No .git directory found at ${workspacePath}`);
        }

        const entries = await collectGitFiles(gitDir);
        const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

        const manifest: GitBackupManifest = {
          version: "repo_backup_manifest/v1",
          workspacePath,
          createdAt: new Date().toISOString(),
          totalFiles: entries.length,
          totalSize,
          entries,
        };

        const keyPair = await ensureKeyPair(dataDir);
        const packed = await packGitDir(gitDir);
        const { encryptedData, encryptedKey, iv } = encryptBuffer(packed, keyPair.publicKey);

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const prefix = config.oss.pathPrefix ? `${config.oss.pathPrefix}/` : "";
        const baseName = `${prefix}backup-${timestamp}`;

        await Promise.all([
          uploadToOss(config.oss, `${baseName}/data.enc`, encryptedData),
          uploadToOss(config.oss, `${baseName}/key.enc`, encryptedKey),
          uploadToOss(config.oss, `${baseName}/iv.bin`, iv),
          uploadToOss(
            config.oss,
            `${baseName}/manifest.json`,
            Buffer.from(JSON.stringify(manifest, null, 2)),
            "application/json",
          ),
        ]);

        lastStatus = {
          running: false,
          lastBackupAt: manifest.createdAt,
          lastBackupFiles: manifest.totalFiles,
          lastBackupSize: manifest.totalSize,
          error: null,
        };

        return manifest;
      } catch (err) {
        lastStatus.running = false;
        lastStatus.error = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },

    async stopBackup() {
      clearScheduler();
      const config = await loadConfig(dataDir);
      config.enabled = false;
      await saveConfig(dataDir, config);
      lastStatus.running = false;
    },

    async exportPrivateKey() {
      return readPrivateKey(dataDir);
    },

    async getPublicKey() {
      const keyPair = await ensureKeyPair(dataDir);
      return keyPair.publicKey;
    },

    async hasCompletedOnboarding() {
      return existsSync(getOnboardingPath(dataDir));
    },

    async markOnboardingComplete() {
      await mkdir(dataDir, { recursive: true });
      await writeFile(getOnboardingPath(dataDir), new Date().toISOString(), "utf-8");
    },
  };
}
