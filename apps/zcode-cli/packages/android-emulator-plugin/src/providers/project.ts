import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inside } from "../lib/path.js";
import { androidApiLevel } from "./config.js";
import { templateFiles } from "./project-template.js";
import { sdkRoot } from "./sdk.js";

type Found = {
  root?: string;
  gradleRoots: string[];
  modules: string[];
  variants: string[];
  applicationIds: string[];
  manifests: string[];
  apks: string[];
  hasWrapper: boolean;
  hasGradleProperties: boolean;
  hasLocalProperties: boolean;
  warnings: string[];
};

export async function discover(dir = process.cwd()): Promise<Found> {
  const gradleRoots: string[] = [];
  const manifests: string[] = [];
  await walkProjectFiles(dir, 5, async (file, item) => {
    if (item.isFile() && /^settings\.gradle(\.kts)?$/.test(item.name))
      gradleRoots.push(path.relative(dir, path.dirname(file)));
    if (item.isFile() && item.name === "AndroidManifest.xml")
      manifests.push(path.relative(dir, file));
  });

  const root = gradleRoots.find((item) => item === "") ?? gradleRoots[0];
  const absRoot = root === undefined ? undefined : path.join(dir, root);
  const modules = absRoot ? await modulesFor(absRoot) : [];
  const ids = absRoot ? await applicationIds(absRoot) : [];
  const apks = absRoot
    ? (await findApks(absRoot, modules)).map((file) => path.relative(dir, file))
    : [];
  const hasWrapper = absRoot
    ? await exists(path.join(absRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew"))
    : false;
  const hasGradleProperties = absRoot
    ? await exists(path.join(absRoot, "gradle.properties"))
    : false;
  const hasLocalProperties = absRoot ? await exists(path.join(absRoot, "local.properties")) : false;
  const warnings = projectWarnings({ hasWrapper, hasGradleProperties, hasLocalProperties });

  return {
    root,
    gradleRoots,
    modules,
    variants: ["debug"],
    applicationIds: ids,
    manifests,
    apks,
    hasWrapper,
    hasGradleProperties,
    hasLocalProperties,
    warnings,
  };
}

function projectWarnings(input: {
  hasWrapper: boolean;
  hasGradleProperties: boolean;
  hasLocalProperties: boolean;
}): string[] {
  const warnings: string[] = [];
  if (!input.hasGradleProperties) {
    warnings.push(
      "Missing gradle.properties. Add android.useAndroidX=true for AndroidX/Compose projects.",
    );
  }
  if (!input.hasLocalProperties) {
    warnings.push(
      "Missing local.properties. Add sdk.dir=<Android SDK path> when Gradle cannot infer the SDK from the environment.",
    );
  }
  if (!input.hasWrapper) {
    warnings.push("Missing Gradle wrapper. Install Gradle or generate ./gradlew before building.");
  }
  return warnings;
}

export async function create(input: {
  name: string;
  packageName?: string;
  dir?: string;
  minSdk?: number;
  compileSdk?: number;
  overwrite?: boolean;
}) {
  const cwd = process.cwd();
  const name = cleanName(input.name);
  const root = inside(cwd, input.dir || name);
  const pkg = packageName(input.packageName || `com.example.${slug(name)}`);
  const minSdk = sdkLevel(input.minSdk ?? 23, "minSdk");
  const compileSdk = sdkLevel(input.compileSdk ?? androidApiLevel(), "compileSdk");
  const files = templateFiles(root, pkg, await sdkRoot());

  if (!input.overwrite) {
    const hits = await present(files.map((item) => item.path));
    if (hits.length) {
      throw new Error(
        `Refusing to overwrite existing Android app files: ${hits.map((file) => path.relative(cwd, file)).join(", ")}`,
      );
    }
  }

  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.body({ name, pkg, minSdk, compileSdk }), "utf8");
  }

  return {
    root: path.relative(cwd, root) || ".",
    module: "app",
    variant: "debug",
    applicationId: pkg,
    files: files.map((file) => path.relative(cwd, file.path)),
    createdBy: "template",
    note: "Build uses ./gradlew when present. If the wrapper is missing, android_build_app can generate it with gradle from PATH.",
  };
}

async function modulesFor(root: string): Promise<string[]> {
  const settings =
    (await readFile(path.join(root, "settings.gradle.kts"), "utf8").catch(() => undefined)) ??
    (await readFile(path.join(root, "settings.gradle"), "utf8").catch(() => ""));
  const modules = [...settings.matchAll(/include\(([^)]+)\)/g)]
    .flatMap((match) =>
      [...String(match[1]).matchAll(/["'](:[^"']+)["']/g)].map((hit) => hit[1] ?? ""),
    )
    .filter(Boolean);
  return modules.length ? modules : ["app"];
}

async function applicationIds(root: string): Promise<string[]> {
  const ids = new Set<string>();
  await walkProjectFiles(root, 5, async (file, item) => {
    if (!item.isFile()) return;
    if (/build\.gradle(\.kts)?$/.test(item.name)) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const match of text.matchAll(
        /(?:applicationId|namespace)\s*(?:=|\s)\s*["']([^"']+)["']/g,
      )) {
        if (match[1]) ids.add(match[1]);
      }
    }
    if (item.name === "AndroidManifest.xml") {
      const text = await readFile(file, "utf8").catch(() => "");
      const match = text.match(/\bpackage=["']([^"']+)["']/);
      if (match?.[1]) ids.add(match[1]);
    }
  });
  return [...ids];
}

export async function findApks(root: string, modules: string[] = []): Promise<string[]> {
  const names = modules.length ? modules.map((item) => item.replace(/^:+/, "") || "app") : ["app"];
  const roots = [
    ...names.map((name) => path.join(root, name, "build", "outputs", "apk")),
    path.join(root, "build", "outputs", "apk"),
  ];
  const hits = await Promise.all(roots.map((dir) => walkApks(dir, 5)));
  return unique(hits.flat());
}

async function walkProjectFiles(
  dir: string,
  depth: number,
  cb: (file: string, item: Dirent) => Promise<void>,
): Promise<void> {
  if (depth < 0) return;
  const items: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    items
      .filter(
        (item) =>
          !item.name.startsWith(".") && !["node_modules", "build", ".gradle"].includes(item.name),
      )
      .map(async (item) => {
        const file = path.join(dir, item.name);
        await cb(file, item);
        if (item.isDirectory()) await walkProjectFiles(file, depth - 1, cb);
      }),
  );
}

async function walkApks(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      items
        .filter((item) => !item.name.startsWith("."))
        .map(async (item) => {
          const file = path.join(dir, item.name);
          if (item.isFile() && item.name.endsWith(".apk")) return [file];
          if (item.isDirectory()) return walkApks(file, depth - 1);
          return [];
        }),
    )
  ).flat();
}

async function present(files: string[]): Promise<string[]> {
  return (
    await Promise.all(
      files.map(async (file) => {
        const hit = await exists(file);
        return hit ? file : undefined;
      }),
    )
  ).filter((file): file is string => file !== undefined);
}

async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

function cleanName(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]/g, "");
  if (!out) throw new Error("App name must contain letters or numbers.");
  if (/^[0-9]/.test(out)) return `App${out}`;
  return out;
}

function packageName(value: string): string {
  const parts = value.split(".");
  const good = parts.length > 1 && parts.every((part) => /^[A-Za-z][A-Za-z0-9_]*$/.test(part));
  if (!good) throw new Error(`Invalid Android package name: ${value}`);
  return value;
}

function sdkLevel(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 21 || value > 99)
    throw new Error(`Invalid ${field}: ${value}`);
  return value;
}

function slug(value: string): string {
  const out = value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  if (/^[0-9]/.test(out)) return `app_${out}`;
  return out || "app";
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
