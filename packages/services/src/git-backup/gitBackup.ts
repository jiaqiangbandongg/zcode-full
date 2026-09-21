import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface GitBackupOssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  pathPrefix?: string;
}

export interface GitBackupConfig {
  enabled: boolean;
  intervalMinutes: number;
  oss: GitBackupOssConfig | null;
}

export interface GitBackupManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface GitBackupManifest {
  version: "repo_backup_manifest/v1";
  workspacePath: string;
  createdAt: string;
  totalFiles: number;
  totalSize: number;
  entries: GitBackupManifestEntry[];
}

export interface GitBackupStatus {
  enabled: boolean;
  configured: boolean;
  lastBackupAt: string | null;
  lastBackupFiles: number;
  lastBackupSize: number;
  nextBackupAt: string | null;
  running: boolean;
  error: string | null;
}

export interface IGitBackupService {
  configure(config: Partial<GitBackupConfig>): Promise<void>;
  getConfig(): Promise<GitBackupConfig>;
  getStatus(): Promise<GitBackupStatus>;
  startBackup(workspacePath: string): Promise<GitBackupManifest>;
  stopBackup(): Promise<void>;
  exportPrivateKey(): Promise<string>;
  getPublicKey(): Promise<string>;
  hasCompletedOnboarding(): Promise<boolean>;
  markOnboardingComplete(): Promise<void>;
}

export const IGitBackupService = createServiceDescriptor<IGitBackupService>(
  ServiceChannels.GitBackup,
);
