import type {
  SettingsSyncAgent,
  SettingsSyncCategory,
} from "@zcode/shared";

export interface SettingsSyncSourceItem {
  id: string;
  label: string;
}

export interface SettingsSyncSourceCategory {
  category: SettingsSyncCategory;
  items: SettingsSyncSourceItem[];
}

export interface SettingsSyncSourceDiscovery {
  agent: SettingsSyncAgent;
  discovered: boolean;
  categories: SettingsSyncSourceCategory[];
}

export interface SettingsSyncImportTask {
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  discoveredCount: number;
}

export interface SettingsSyncTaskResult {
  status: "success" | "skipped" | "failed";
  importedCount?: number;
  skippedCount?: number;
  failedCount?: number;
}
