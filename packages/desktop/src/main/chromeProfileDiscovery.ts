import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildStandardChromeInstallations,
  parseRunningChromeInstallations,
  type ChromeBrowserKind,
  type ChromeInstallationCandidate,
  type ChromeInstallationPathOptions,
  type LinuxChromePasswordStore,
} from "./chromeInstallationCandidates.js";
import { readRunningChromeProcessCommandLines } from "./chromeExecutableDiscovery.js";

export {
  buildStandardChromeInstallations,
  parseRunningChromeInstallations,
  type ChromeInstallationCandidate,
  type LinuxChromePasswordStore,
} from "./chromeInstallationCandidates.js";
export { resolveChromeExecutablePath } from "./chromeExecutableDiscovery.js";

const DISCOVERY_COMMAND_TIMEOUT_MS = 3_000;
const PROFILE_DIRECTORY_PATTERN = /^(?:Default|Profile \d+)$/;

export interface ChromeProfileSource {
  browser: ChromeBrowserKind;
  executablePath?: string;
  passwordStore?: LinuxChromePasswordStore;
  profileDirectory: string;
  profilePath: string;
  userDataDir: string;
}

export type ChromeProfileDiscoveryResult =
  | { success: true; source: ChromeProfileSource }
  | { success: false; error: "chrome_profile_not_found" | "chrome_profile_ambiguous" };

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, unknown>;
    last_used?: string;
  };
}

export interface ChromeProfileDiscoveryOptions extends ChromeInstallationPathOptions {
  installations?: ChromeInstallationCandidate[];
  processCommandLines?: string[];
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: DISCOVERY_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function expandWindowsPolicyPath(value: string, options: ChromeProfileDiscoveryOptions): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const variables: Record<string, string> = {
    local_app_data: options.localAppData ?? env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
    profile: env.USERPROFILE ?? homeDir,
    program_files: options.programFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
  };
  return value
    .replace(/\$\{([^}]+)\}/g, (match, name: string) => variables[name.toLowerCase()] ?? match)
    .replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? env[name.toUpperCase()] ?? match);
}

async function readWindowsPolicyUserDataDirs(
  options: ChromeProfileDiscoveryOptions,
): Promise<string[]> {
  const keys = [
    "HKCU\\Software\\Policies\\Google\\Chrome",
    "HKLM\\Software\\Policies\\Google\\Chrome",
  ];
  const values: string[] = [];
  for (const key of keys) {
    try {
      const output = await execFileText("reg.exe", ["query", key, "/v", "UserDataDir"]);
      const value = output.match(/UserDataDir\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1]?.trim();
      if (value) values.push(expandWindowsPolicyPath(value, options));
    } catch {
      // 没有企业策略是正常状态。
    }
  }
  return uniquePaths(values);
}

async function resolveFirstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

async function readProfileDirectoryCandidates(userDataDir: string): Promise<{
  lastUsed?: string;
  profiles: string[];
}> {
  let localState: ChromeLocalState = {};
  try {
    localState = JSON.parse(
      await readFile(join(userDataDir, "Local State"), "utf8"),
    ) as ChromeLocalState;
  } catch {
    // Local State 损坏或暂时不可读时，仍允许通过目录 fallback 发现 Profile。
  }

  const names = new Set<string>(Object.keys(localState.profile?.info_cache ?? {}));
  try {
    for (const entry of await readdir(userDataDir, { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_DIRECTORY_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch {
    return { profiles: [] };
  }

  const profiles: string[] = [];
  for (const name of names) {
    if (await pathExists(join(userDataDir, name))) profiles.push(name);
  }
  return {
    lastUsed: localState.profile?.last_used,
    profiles: profiles.sort((a, b) => a.localeCompare(b)),
  };
}

async function hasImportableProfileData(profilePath: string): Promise<boolean> {
  const candidates = [
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies"),
    join(profilePath, "Local Storage", "leveldb"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

async function filterImportableProfiles(
  userDataDir: string,
  profiles: string[],
): Promise<string[]> {
  const availability = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      importable: await hasImportableProfileData(join(userDataDir, profile)),
    })),
  );
  return availability.filter(({ importable }) => importable).map(({ profile }) => profile);
}

function selectProfileDirectory(
  profiles: string[],
  lastUsed?: string,
): { profileDirectory?: string; ambiguous: boolean } {
  if (lastUsed && profiles.includes(lastUsed)) {
    return { profileDirectory: lastUsed, ambiguous: false };
  }
  if (profiles.includes("Default")) {
    return { profileDirectory: "Default", ambiguous: false };
  }
  if (profiles.length === 1) {
    return { profileDirectory: profiles[0], ambiguous: false };
  }
  return { ambiguous: profiles.length > 1 };
}

function dedupeInstallations(
  installations: ChromeInstallationCandidate[],
): ChromeInstallationCandidate[] {
  const result: ChromeInstallationCandidate[] = [];
  const seen = new Set<string>();
  for (const installation of installations) {
    const userDataDir = installation.userDataDir.trim();
    if (!userDataDir || seen.has(userDataDir)) continue;
    seen.add(userDataDir);
    result.push({ ...installation, userDataDir });
  }
  return result;
}

export async function discoverChromeProfile(
  options: ChromeProfileDiscoveryOptions = {},
): Promise<ChromeProfileDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const standardInstallations = options.installations ?? buildStandardChromeInstallations(options);
  const environmentInstallations =
    !options.installations && platform === "linux" && env.CHROME_USER_DATA_DIR
      ? [
          {
            browser: "chrome" as const,
            userDataDir: env.CHROME_USER_DATA_DIR,
            executablePaths: standardInstallations[0]?.executablePaths ?? [],
          },
        ]
      : [];
  const commandLines =
    options.processCommandLines ??
    (options.installations ? [] : await readRunningChromeProcessCommandLines(platform));
  const runningInstallations = parseRunningChromeInstallations(
    commandLines,
    platform === "linux" ? [...environmentInstallations, ...standardInstallations] : [],
  );
  const policyInstallations =
    platform === "win32" && !options.installations
      ? (await readWindowsPolicyUserDataDirs(options)).map((userDataDir) => ({
          browser: "chrome" as const,
          userDataDir,
          executablePaths: standardInstallations[0]?.executablePaths ?? [],
        }))
      : [];
  const installations = dedupeInstallations([
    ...runningInstallations,
    ...environmentInstallations,
    ...policyInstallations,
    ...standardInstallations,
  ]);

  for (const installation of installations) {
    if (!(await pathExists(installation.userDataDir))) continue;
    const { lastUsed, profiles } = await readProfileDirectoryCandidates(installation.userDataDir);
    // 过去只要标准 Default 目录存在就立即返回，即使里面没有 Cookie/LocalStorage，
    // 从而遮蔽同安装的真实 Profile 以及后续 Snap/Flatpak 候选。发现阶段先过滤空 Profile。
    const importableProfiles = await filterImportableProfiles(installation.userDataDir, profiles);
    if (importableProfiles.length === 0) continue;
    const selected = selectProfileDirectory(importableProfiles, lastUsed);
    if (selected.ambiguous) return { success: false, error: "chrome_profile_ambiguous" };
    if (!selected.profileDirectory) continue;
    const executablePath =
      installation.executablePath ?? (await resolveFirstExistingPath(installation.executablePaths));
    return {
      success: true,
      source: {
        browser: installation.browser,
        executablePath,
        passwordStore: installation.passwordStore,
        profileDirectory: selected.profileDirectory,
        profilePath: join(installation.userDataDir, selected.profileDirectory),
        userDataDir: installation.userDataDir,
      },
    };
  }
  return { success: false, error: "chrome_profile_not_found" };
}
