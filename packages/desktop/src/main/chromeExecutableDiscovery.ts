import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  buildStandardChromeInstallations,
  isChromeBrowserExecutable,
  parseRunningChromeExecutablePaths,
  type ChromeInstallationCandidate,
  type ChromeInstallationPathOptions,
} from "./chromeInstallationCandidates.js";

const DISCOVERY_COMMAND_TIMEOUT_MS = 3_000;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>([
  "darwin",
  "linux",
  "win32",
]);

export interface ChromeExecutableDiscoveryOptions extends ChromeInstallationPathOptions {
  installations?: ChromeInstallationCandidate[];
  processCommandLines?: string[];
  /** 测试可注入已由操作系统注册表/索引解析出的可执行文件，避免依赖宿主环境。 */
  registeredExecutablePaths?: string[];
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

export async function readRunningChromeProcessCommandLines(
  platform: NodeJS.Platform,
): Promise<string[]> {
  if (!SUPPORTED_PLATFORMS.has(platform)) return [];
  try {
    if (platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium)\\.exe$' } | ForEach-Object { $_.CommandLine }";
      return (
        await execFileText("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ])
      )
        .split(/\r?\n/)
        .filter(Boolean);
    }
    return (await execFileText("ps", ["-axo", "command="]))
      .split(/\r?\n/)
      .filter((line) => /(?:chrome|chromium)/i.test(line));
  } catch {
    // 进程枚举受系统策略限制时，仍应继续使用注册信息和标准目录，不能阻断导入。
    return [];
  }
}

async function isExecutableFile(
  path: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirstExecutable(
  paths: Array<string | undefined>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  for (const executablePath of uniquePaths(paths)) {
    if (!isChromeBrowserExecutable(executablePath)) continue;
    if (await isExecutableFile(executablePath, platform)) return executablePath;
  }
  return null;
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function desktopExecutableToken(value: string): string | undefined {
  const tokens = [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  if (tokens[0] !== "env") return tokens[0];
  return tokens
    .slice(1)
    .find((token) => !token.startsWith("-") && !token.includes("="));
}

function resolvePathCommand(command: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [];
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
}

async function readMacRegisteredChromeExecutablePaths(): Promise<string[]> {
  const bundleIds = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.google.Chrome.forTesting",
    "org.chromium.Chromium",
  ];
  try {
    const output = await execFileText("mdfind", [
      bundleIds
        .map((bundleId) => `kMDItemCFBundleIdentifier == '${bundleId}'`)
        .join(" || "),
    ]);
    const executablePaths: string[] = [];
    for (const appPath of output.split(/\r?\n/).filter(Boolean)) {
      try {
        const executableDirectory = join(appPath, "Contents", "MacOS");
        for (const entry of await readdir(executableDirectory, {
          withFileTypes: true,
        })) {
          if (
            (entry.isFile() || entry.isSymbolicLink()) &&
            isChromeBrowserExecutable(entry.name)
          ) {
            executablePaths.push(join(executableDirectory, entry.name));
          }
        }
      } catch {
        // Spotlight 索引可能含已移除应用；忽略陈旧记录并继续检查其他候选。
      }
    }
    return uniquePaths(executablePaths);
  } catch {
    // Spotlight 被禁用或受系统策略限制时，仍会继续使用运行进程和标准目录。
    return [];
  }
}

async function readLinuxDesktopChromeExecutablePaths(
  options: ChromeExecutableDiscoveryOptions,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const dataDirectories = uniquePaths([
    env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ]);
  const executablePaths: string[] = [];
  for (const dataDirectory of dataDirectories) {
    const applicationsDirectory = join(dataDirectory, "applications");
    try {
      for (const entry of await readdir(applicationsDirectory, {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
        try {
          const source = await readFile(
            join(applicationsDirectory, entry.name),
            "utf8",
          );
          if (!/(?:chrome|chromium)/i.test(source)) continue;
          for (const line of source.split(/\r?\n/)) {
            const value = line.match(/^(?:TryExec|Exec)=(.+)$/)?.[1];
            const command = value ? desktopExecutableToken(value) : undefined;
            if (command)
              executablePaths.push(...resolvePathCommand(command, env));
          }
        } catch {
          // 单个 desktop entry 损坏或无权限不应阻断其他已注册应用发现。
        }
      }
    } catch {
      // 某个 XDG applications 目录不存在是正常状态。
    }
  }
  return uniquePaths(executablePaths);
}

function buildLinuxPathChromeExecutablePaths(env: NodeJS.ProcessEnv): string[] {
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "google-chrome-unstable",
    "google-chrome-canary",
    "google-chrome-for-testing",
    "chromium",
    "chromium-browser",
    "com.google.Chrome",
    "org.chromium.Chromium",
  ];
  return uniquePaths(names.flatMap((name) => resolvePathCommand(name, env)));
}

async function readRegisteredChromeExecutablePaths(
  options: ChromeExecutableDiscoveryOptions,
  platform: NodeJS.Platform,
): Promise<string[]> {
  if (options.registeredExecutablePaths)
    return options.registeredExecutablePaths;
  if (platform === "darwin") return readMacRegisteredChromeExecutablePaths();
  if (platform === "linux")
    return readLinuxDesktopChromeExecutablePaths(options);
  return [];
}

export async function resolveChromeExecutablePath(
  options: ChromeExecutableDiscoveryOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const commandLines =
    options.processCommandLines ??
    (options.installations
      ? []
      : await readRunningChromeProcessCommandLines(platform));
  const directlyDiscovered = await resolveFirstExecutable(
    [
      stripMatchingQuotes(env.CHROME_PATH ?? ""),
      stripMatchingQuotes(env.CHROME_EXECUTABLE ?? ""),
      ...parseRunningChromeExecutablePaths(commandLines),
    ],
    platform,
  );
  if (directlyDiscovered) return directlyDiscovered;

  const registered = await resolveFirstExecutable(
    await readRegisteredChromeExecutablePaths(options, platform),
    platform,
  );
  if (registered) return registered;

  const installations =
    options.installations ?? buildStandardChromeInstallations(options);
  return resolveFirstExecutable(
    [
      ...(platform === "linux" ? buildLinuxPathChromeExecutablePaths(env) : []),
      ...installations.flatMap((installation) => [
        installation.executablePath,
        ...installation.executablePaths,
      ]),
    ],
    platform,
  );
}
