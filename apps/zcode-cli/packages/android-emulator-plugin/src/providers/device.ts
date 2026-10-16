import { brief, ok, run } from "../lib/run.js";
import { androidEnv, requireTool } from "./sdk.js";

export type Device = {
  serial: string;
  state: string;
  kind: "emulator" | "device";
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  raw: string;
};

const SERIAL = /^[A-Za-z0-9._:-]+$/;
const SAFE_DEVICE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function validSerial(serial: string): boolean {
  return SERIAL.test(serial);
}

export async function listDevices(): Promise<Device[]> {
  const adb = await requireTool("adb");
  const out = await run([adb, "devices", "-l"], { timeout: 20_000, env: await androidEnv() });
  if (!ok(out)) throw new Error(brief(out));
  return parseAdbDevices(out.stdout);
}

export function parseAdbDevices(value: string): Device[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0] ?? "";
      const state = parts[1] ?? "unknown";
      const attrs = new Map<string, string>();
      for (const part of parts.slice(2)) {
        const split = part.indexOf(":");
        if (split > 0) attrs.set(part.slice(0, split), part.slice(split + 1));
      }
      return {
        serial,
        state,
        kind: serial.startsWith("emulator-") ? "emulator" : "device",
        model: attrs.get("model"),
        product: attrs.get("product"),
        device: attrs.get("device"),
        transportId: attrs.get("transport_id"),
        raw: line,
      } satisfies Device;
    })
    .filter((item) => item.serial.length > 0);
}

export async function pickDevice(input: { serial?: string } = {}): Promise<Device> {
  const devices = await listDevices();
  if (input.serial) {
    if (!validSerial(input.serial))
      throw new Error(`Invalid Android device serial: ${input.serial}`);
    const hit = devices.find((item) => item.serial === input.serial);
    if (!hit) throw new Error(`Android device not found: ${input.serial}`);
    if (hit.state !== "device")
      throw new Error(`Android device is not ready: ${input.serial} (${hit.state})`);
    return hit;
  }
  const online = devices.filter((item) => item.state === "device");
  const emulator = online.find((item) => item.kind === "emulator");
  if (emulator) return emulator;
  const first = online[0];
  if (first) return first;
  throw new Error("No ready Android device or emulator found.");
}

export async function adbShell(serial: string, args: string[], timeout = 30_000) {
  if (!validSerial(serial)) throw new Error(`Invalid Android device serial: ${serial}`);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", serial, "shell", adbShellCommand(args)], {
    timeout,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return out;
}

export function adbShellCommand(args: string[]): string {
  if (args.length === 0) throw new Error("Missing adb shell command.");
  return args.map(deviceShellQuote).join(" ");
}

export async function isBootComplete(serial: string): Promise<boolean> {
  const out = await adbShell(serial, ["getprop", "sys.boot_completed"], 10_000).catch(
    () => undefined,
  );
  return out?.stdout.trim() === "1";
}

function deviceShellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (SAFE_DEVICE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
