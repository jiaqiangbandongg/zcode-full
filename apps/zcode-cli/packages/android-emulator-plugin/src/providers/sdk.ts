import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brief, ok, run } from "../lib/run.js";
import { javaMajorVersion } from "./config.js";

const TOOL_PATHS: Record<string, string[]> = {
  adb: ["platform-tools/adb"],
  emulator: ["emulator/emulator"],
  sdkmanager: [
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/bin/sdkmanager",
    "tools/bin/sdkmanager",
  ],
  avdmanager: [
    "cmdline-tools/latest/bin/avdmanager",
    "cmdline-tools/bin/avdmanager",
    "tools/bin/avdmanager",
  ],
  apkanalyzer: ["cmdline-tools/latest/bin/apkanalyzer", "cmdline-tools/bin/apkanalyzer"],
};

type ToolCheck = {
  name: string;
  path?: string;
  ok: boolean;
  detail: string;
};

function sdkRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [env.ANDROID_PLUGIN_SDK_PATH, env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (item): item is string => Boolean(item && item.trim()),
  );
  return unique([
    ...configured,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    ...windowsSdkRoots(env),
    "/opt/android-sdk",
    "/usr/local/share/android-sdk",
    "/opt/homebrew/share/android-commandlinetools",
  ]);
}

export async function sdkRoot(): Promise<string | undefined> {
  for (const item of sdkRoots()) {
    if (await exists(item)) return item;
  }
  return undefined;
}

export async function findTool(name: string): Promise<string | undefined> {
  const viaPath = await which(name);
  if (viaPath) return viaPath;
  const rels = TOOL_PATHS[name] ?? [];
  for (const root of sdkRoots()) {
    for (const rel of rels) {
      for (const candidate of executableCandidates(path.join(root, rel))) {
        if (await exists(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

export async function requireTool(name: string): Promise<string> {
  const found = await findTool(name);
  if (found) return found;
  throw new Error(`Missing Android tool: ${name}. Run android_preflight for setup details.`);
}

export async function checkTool(
  name: string,
  versionArgs: string[] = ["--version"],
): Promise<ToolCheck> {
  const found = await findTool(name);
  if (!found) {
    return {
      name,
      ok: false,
      detail: "not found",
    };
  }
  const out = await run([found, ...versionArgs], { timeout: 10_000, env: await androidEnv() });
  return {
    name,
    path: found,
    ok: ok(out),
    detail: ok(out) ? brief(out, 1000) || found : brief(out, 1000),
  };
}

export async function androidEnv(): Promise<Record<string, string | undefined>> {
  const root = await sdkRoot();
  const java = await javaHome();
  const paths = [
    java ? path.join(java, "bin") : undefined,
    root ? path.join(root, "platform-tools") : undefined,
    root ? path.join(root, "emulator") : undefined,
    root ? path.join(root, "cmdline-tools", "latest", "bin") : undefined,
    root ? path.join(root, "cmdline-tools", "bin") : undefined,
    root ? path.join(root, "tools", "bin") : undefined,
    process.env.PATH,
  ].filter((item): item is string => Boolean(item));
  return {
    JAVA_HOME: java,
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    PATH: paths.join(path.delimiter),
  };
}

export async function javaHome(): Promise<string | undefined> {
  const version = javaMajorVersion();
  const configured = process.env.JAVA_HOME?.trim();
  if (configured && (await exists(path.join(configured, "bin", javaBin())))) return configured;

  if (process.platform === "darwin") {
    const home = await run(["/usr/libexec/java_home", "-v", version], { timeout: 5000 });
    if (ok(home)) {
      const value = home.stdout.trim();
      if (value) return value;
    }
  }

  for (const candidate of await javaHomes(version)) {
    if (await exists(path.join(candidate, "bin", javaBin()))) return candidate;
  }
  return undefined;
}

async function which(name: string): Promise<string | undefined> {
  const out = await run(process.platform === "win32" ? ["where", name] : ["which", name], {
    timeout: 5000,
  });
  if (!ok(out)) return undefined;
  const found = out.stdout.trim().split("\n")[0];
  return found || undefined;
}

async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function executableCandidates(base: string): string[] {
  if (process.platform !== "win32") return [base];
  const ext = path.extname(base);
  if (ext) return [base];
  return [".exe", ".bat", ".cmd", ""].map((suffix) => `${base}${suffix}`);
}

function javaBin(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}

function windowsSdkRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
  ].filter((item): item is string => Boolean(item));
}

async function javaHomes(version: string): Promise<string[]> {
  const fixed = [
    `/opt/homebrew/opt/openjdk@${version}/libexec/openjdk.jdk/Contents/Home`,
    `/Library/Java/JavaVirtualMachines/openjdk-${version}.jdk/Contents/Home`,
    path.join(process.env.ProgramFiles || "", "Eclipse Adoptium", `jdk-${version}`),
    path.join(process.env.ProgramFiles || "", "Java", `jdk-${version}`),
  ].filter(Boolean);
  if (process.platform !== "win32") return fixed;
  const pattern = new RegExp(`^jdk-${escapeRegex(version)}`, "i");
  return unique([
    ...fixed,
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Eclipse Adoptium"), pattern)),
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Java"), pattern)),
  ]);
}

async function childDirs(root: string, pattern: RegExp): Promise<string[]> {
  if (!root) return [];
  const items = await readdir(root, { withFileTypes: true }).catch(() => []);
  return items
    .filter((item) => item.isDirectory() && pattern.test(item.name))
    .map((item) => path.join(root, item.name));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
