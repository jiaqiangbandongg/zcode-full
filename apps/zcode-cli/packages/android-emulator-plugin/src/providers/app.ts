import { inside } from "../lib/path.js";
import { brief, ok, run } from "../lib/run.js";
import { ensureDevice } from "./avd.js";
import { adbShell, validSerial } from "./device.js";
import { androidEnv, requireTool } from "./sdk.js";

type Target = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export async function install(input: Target & { apkPath: string }) {
  const device = await ensureDevice(input);
  const apk = inside(process.cwd(), input.apkPath);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", device.serial, "install", "-r", apk], {
    timeout: input.timeoutMs ?? 120_000,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return { installed: true, serial: device.serial, apkPath: input.apkPath, output: brief(out) };
}

export async function launch(input: Target & { applicationId: string; activity?: string }) {
  const device = await ensureDevice(input);
  const app = packageName(input.applicationId);
  const out = input.activity
    ? await adbShell(
        device.serial,
        ["am", "start", "-W", "-n", `${app}/${input.activity}`],
        input.timeoutMs ?? 60_000,
      )
    : await adbShell(
        device.serial,
        ["monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"],
        input.timeoutMs ?? 60_000,
      );
  return { launched: true, serial: device.serial, applicationId: app, output: brief(out) };
}

export async function terminate(input: Target & { applicationId: string }) {
  const device = await ensureDevice(input);
  const app = packageName(input.applicationId);
  await adbShell(device.serial, ["am", "force-stop", app], input.timeoutMs ?? 30_000);
  return { terminated: true, serial: device.serial, applicationId: app };
}

export async function openUrl(input: Target & { url: string }) {
  const device = await ensureDevice(input);
  const value = url(input.url);
  await adbShell(
    device.serial,
    ["am", "start", "-a", "android.intent.action.VIEW", "-d", value],
    input.timeoutMs ?? 30_000,
  );
  return { opened: true, serial: device.serial, url: value };
}

export function packageName(value: string): string {
  if (!PACKAGE.test(value)) throw new Error(`Invalid Android application id: ${value}`);
  return value;
}

function url(value: string): string {
  if (value.length > 2048) throw new Error("URL is too long.");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new Error(`Invalid URL: ${value}`);
  return value;
}
