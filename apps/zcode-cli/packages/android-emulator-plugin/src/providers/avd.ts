import { spawn as spawnChild } from "node:child_process";
import { brief, ok, run } from "../lib/run.js";
import { androidSystemImagePackage } from "./config.js";
import { isBootComplete, listDevices, pickDevice, validSerial, type Device } from "./device.js";
import { androidEnv, requireTool } from "./sdk.js";

type Avd = {
  name: string;
};

type StartInput = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

type StartResult = Device & {
  reused: boolean;
  started: boolean;
};

const AVD = /^[A-Za-z0-9_. -]+$/;
const EMULATOR_BOOT_POLL_MS = 2_000;
const AVD_NAME_TIMEOUT_MS = 5_000;

export async function listAvds(): Promise<Avd[]> {
  const emulator = await requireTool("emulator");
  const out = await run([emulator, "-list-avds"], { timeout: 20_000, env: await androidEnv() });
  if (!ok(out)) throw new Error(brief(out));
  return parseAvds(out.stdout);
}

export function parseAvds(value: string): Avd[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((name) => ({ name }));
}

export async function ensureDevice(input: StartInput = {}): Promise<Device> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (input.serial) return waitForReadyTarget(await pickDevice({ serial: input.serial }), timeoutMs);
  const ready = await pickDevice().catch(() => undefined);
  if (ready) return waitForReadyTarget(ready, timeoutMs);
  return startEmulator(input);
}

export async function startEmulator(input: StartInput = {}): Promise<StartResult> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (input.serial) {
    throw new Error(
      "android_start_emulator always starts a new emulator. Reuse an existing target by passing serial to build, install, launch, screenshot, log, or UI tools.",
    );
  }
  const avd = await pickAvd(input.avd);
  const running = await runningAvd(avd.name);
  if (running) {
    throw new Error(
      `Android AVD "${avd.name}" is already running as ${running.serial}. Reuse it by passing serial "${running.serial}" to target tools, or choose another AVD.`,
    );
  }
  const before = new Set((await listDevices().catch(() => [])).map((item) => item.serial));
  const emulator = await requireTool("emulator");
  const env = await androidEnv();
  const child = spawnChild(emulator, ["-avd", avd.name], {
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (item): item is [string, string] => typeof item[1] === "string",
      ),
    ),
    shell: false,
    stdio: "ignore",
  });
  await waitForSpawn(child);
  child.unref();
  const device = await waitForStartedDevice(before, avd.name, timeoutMs);
  return targetResult({ ...device, raw: `${device.raw} pid:${child.pid}` }, true);
}

export async function stopEmulator(input: { serial: string }) {
  if (!validSerial(input.serial)) throw new Error(`Invalid Android device serial: ${input.serial}`);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", input.serial, "emu", "kill"], {
    timeout: 20_000,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return { stopped: true, serial: input.serial };
}

export async function createAvd(
  input: { name?: string; packageId?: string; device?: string; force?: boolean } = {},
) {
  const name = cleanAvd(input.name || process.env.ANDROID_PLUGIN_DEFAULT_AVD || "medium_phone");
  const pkg = input.packageId || defaultSystemImage();
  const avdmanager = await requireTool("avdmanager");
  const args = ["create", "avd", "--name", name, "--package", pkg];
  if (input.device) args.push("--device", input.device);
  if (input.force) args.push("--force");
  const out = await run([avdmanager, ...args], {
    input: "no\n",
    timeout: 120_000,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return {
    created: true,
    name,
    packageId: pkg,
    output: brief(out),
  };
}

async function pickAvd(name?: string): Promise<Avd> {
  if (name && !AVD.test(name)) throw new Error(`Invalid Android AVD name: ${name}`);
  const avds = await listAvds();
  const want = name || process.env.ANDROID_PLUGIN_DEFAULT_AVD;
  if (want) {
    const hit = avds.find(
      (item) => item.name === want || item.name.toLowerCase().includes(want.toLowerCase()),
    );
    if (hit) return hit;
  }
  const first = avds[0];
  if (first) return first;
  throw new Error(
    "No Android AVDs found. Create one in Android Studio or call android_create_avd after confirming setup.",
  );
}

async function waitForStartedDevice(
  before: Set<string>,
  avdName: string,
  timeoutMs: number,
): Promise<Device> {
  const deadline = Date.now() + timeoutMs;
  let last: Device[] = [];
  while (Date.now() < deadline) {
    last = await listDevices().catch(() => []);
    for (const fresh of startedEmulatorCandidates(last, before)) {
      if (!(await isBootComplete(fresh.serial))) continue;
      const name = await avdNameFor(fresh.serial).catch(() => undefined);
      if (name === avdName) return fresh;
    }
    await sleep(EMULATOR_BOOT_POLL_MS);
  }
  const detail = last.length
    ? last.map((item) => `${item.serial}:${item.state}`).join(", ")
    : "no adb devices";
  throw new Error(`Timed out waiting for Android Emulator to boot (${detail}).`);
}

export function startedEmulatorCandidates(devices: Device[], before: Set<string>): Device[] {
  return devices.filter((item) => {
    return item.kind === "emulator" && item.state === "device" && !before.has(item.serial);
  });
}

async function waitForReadyTarget(device: Device, timeoutMs: number): Promise<Device> {
  if (device.kind !== "emulator") return device;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBootComplete(device.serial)) return device;
    await sleep(EMULATOR_BOOT_POLL_MS);
  }
  throw new Error(`Timed out waiting for Android Emulator to boot (${device.serial}).`);
}

async function runningAvd(name: string): Promise<Device | undefined> {
  const emulators = (await listDevices().catch(() => [])).filter(
    (item) => item.kind === "emulator" && item.state === "device",
  );
  for (const device of emulators) {
    const avdName = await avdNameFor(device.serial).catch(() => undefined);
    if (avdName === name) return device;
  }
  return undefined;
}

async function avdNameFor(serial: string): Promise<string | undefined> {
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", serial, "emu", "avd", "name"], {
    timeout: AVD_NAME_TIMEOUT_MS,
    env: await androidEnv(),
  });
  if (!ok(out)) return undefined;
  return out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== "OK");
}

function targetResult(device: Device, started: boolean): StartResult {
  return {
    ...device,
    reused: !started,
    started,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSpawn(child: ReturnType<typeof spawnChild>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

function cleanAvd(value: string): string {
  if (!AVD.test(value)) throw new Error(`Invalid Android AVD name: ${value}`);
  return value.trim();
}

function defaultSystemImage(): string {
  return androidSystemImagePackage();
}
