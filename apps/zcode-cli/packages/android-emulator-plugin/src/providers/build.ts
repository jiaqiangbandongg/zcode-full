import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { data, inside, rel } from "../lib/path.js";
import { brief, ok, run, type Run } from "../lib/run.js";
import { install, launch } from "./app.js";
import { ensureDevice } from "./avd.js";
import { discover, findApks } from "./project.js";
import { androidEnv, findTool } from "./sdk.js";

type Build = {
  projectDir?: string;
  module?: string;
  variant?: string;
  applicationId?: string;
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

type RunApp = Build & {
  launchActivity?: string;
};

export async function buildApp(input: Build = {}) {
  const root = await projectRoot(input.projectDir);
  const found = await discover(root);
  const module = normalizeModule(input.module || found.modules[0] || "app");
  const variant = input.variant || found.variants[0] || "debug";
  const task = `:${module}:assemble${cap(variant)}`;
  const gradle = await gradleCommand(root);
  const out = await run([...gradle, task], {
    cwd: root,
    timeout: input.timeoutMs ?? 600_000,
    env: await androidEnv(),
  });
  const log = await record("build", out);
  const apk = ok(out) ? await findApk(root, module, variant) : undefined;
  const applicationId = input.applicationId || found.applicationIds[0];

  return {
    ok: ok(out),
    root: rel(root),
    module,
    variant,
    task,
    apkPath: apk ? rel(apk) : undefined,
    applicationId,
    logPath: log,
    code: out.code,
    timedOut: out.timed,
    output: brief(out, 12_000),
  };
}

export async function buildAndRun(input: RunApp = {}) {
  const built = await buildApp(input);
  if (!built.ok) return { ...built, installed: false, launched: false };
  if (!built.apkPath) throw new Error("Build succeeded, but no APK product was found.");
  if (!built.applicationId)
    throw new Error("Build succeeded, but applicationId could not be resolved.");
  const device = await ensureDevice({
    serial: input.serial,
    avd: input.avd,
    timeoutMs: input.timeoutMs,
  });
  const installed = await install({
    serial: device.serial,
    apkPath: built.apkPath,
    timeoutMs: input.timeoutMs,
  });
  const launched = await launch({
    serial: device.serial,
    applicationId: built.applicationId,
    activity: input.launchActivity,
    timeoutMs: input.timeoutMs,
  });
  return { ...built, device, installed, launched };
}

async function projectRoot(raw?: string): Promise<string> {
  if (raw) return inside(process.cwd(), raw);
  const found = await discover();
  if (found.root !== undefined) return inside(process.cwd(), found.root || ".");
  throw new Error("No Android Gradle project found. Use android_create_app first.");
}

async function findApk(
  root: string,
  module: string,
  variant: string,
): Promise<string | undefined> {
  const hits = await findApks(root, [module]);
  return pickApk(hits, variant);
}

export function pickApk(hits: string[], variant: string): string | undefined {
  const want = `${path.sep}${variant.toLowerCase()}${path.sep}`;
  return hits.find((item) => item.toLowerCase().includes(want)) || hits[0];
}

async function gradleCommand(root: string): Promise<string[]> {
  const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (await exists(wrapper)) return [wrapper];
  const gradle = await findTool("gradle");
  if (gradle) {
    const generated = await run([gradle, "wrapper", "--gradle-version", "8.9"], {
      cwd: root,
      timeout: 120_000,
      env: await androidEnv(),
    });
    if (ok(generated) && (await exists(wrapper))) return [wrapper];
    return [gradle];
  }
  throw new Error(
    "No Gradle wrapper or gradle executable found. Generate a wrapper or install Gradle.",
  );
}

async function record(name: string, out: Run): Promise<string> {
  const dir = await data("logs");
  const file = path.join(dir, `${stamp()}-${name}-${key(process.cwd())}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    [
      `$ ${out.cmd.join(" ")}`,
      `exit=${out.code}`,
      `timedOut=${out.timed}`,
      "",
      out.stdout,
      out.stderr,
    ].join("\n"),
    "utf8",
  );
  return rel(file);
}

async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

function normalizeModule(value: string): string {
  return value.replace(/^:+/, "") || "app";
}

function cap(value: string): string {
  return value
    .split(/[-_]/g)
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1))
    .join("");
}

function key(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}
