import { ensureDevice } from "./avd.js";
import { adbShell } from "./device.js";
import { findTool } from "./sdk.js";

type UiTarget = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

type UiElement = {
  index: number;
  text?: string;
  contentDescription?: string;
  resourceId?: string;
  className?: string;
  bounds?: Bounds;
  clickable?: boolean;
  enabled?: boolean;
};

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

const KEY_EVENTS = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  MENU: "KEYCODE_MENU",
  SEARCH: "KEYCODE_SEARCH",
} as const;

const MAX_INPUT_TEXT_LENGTH = 1000;

export async function status() {
  const adb = await findTool("adb");
  const adbAvailable = Boolean(adb);
  return {
    backend: "adb-uiautomator",
    adb,
    adbInput: adbAvailable,
    uiAutomator: adbAvailable,
    available: adbAvailable,
    implementedBackends: adbAvailable ? ["uiautomator", "adb-input"] : [],
  };
}

export async function describe(input: UiTarget = {}) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["uiautomator", "dump", "/sdcard/window.xml"],
    input.timeoutMs ?? 30_000,
  );
  const out = await adbShell(
    device.serial,
    ["cat", "/sdcard/window.xml"],
    input.timeoutMs ?? 30_000,
  );
  const elements = parseUiAutomator(out.stdout);
  return { device, elements };
}

export async function resolve(input: UiTarget & { query: string }) {
  const tree = await describe(input);
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error("UI query must not be empty.");
  const hit = tree.elements.find(
    (item) => elementText(item).toLowerCase().includes(query) && item.bounds,
  );
  if (!hit?.bounds) throw new Error(`No visible Android UI element matched: ${input.query}`);
  return {
    device: tree.device,
    element: hit,
    x: hit.bounds.centerX,
    y: hit.bounds.centerY,
  };
}

export async function tap(input: UiTarget & { x: number; y: number }) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["input", "tap", String(Math.round(input.x)), String(Math.round(input.y))],
    input.timeoutMs ?? 30_000,
  );
  return { tapped: true, serial: device.serial, x: input.x, y: input.y };
}

export async function swipe(
  input: UiTarget & { x1: number; y1: number; x2: number; y2: number; durationMs?: number },
) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    [
      "input",
      "swipe",
      String(Math.round(input.x1)),
      String(Math.round(input.y1)),
      String(Math.round(input.x2)),
      String(Math.round(input.y2)),
      String(Math.round(input.durationMs ?? 300)),
    ],
    input.timeoutMs ?? 30_000,
  );
  return {
    swiped: true,
    serial: device.serial,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
  };
}

export async function typeText(input: UiTarget & { text: string }) {
  const device = await ensureDevice(input);
  const text = inputText(input.text);
  await adbShell(device.serial, ["input", "text", text], input.timeoutMs ?? 30_000);
  return { typed: true, serial: device.serial, length: input.text.length };
}

export async function keyevent(input: UiTarget & { key: keyof typeof KEY_EVENTS }) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["input", "keyevent", KEY_EVENTS[input.key]],
    input.timeoutMs ?? 30_000,
  );
  return { pressed: true, serial: device.serial, key: input.key };
}

export function parseUiAutomator(value: string): UiElement[] {
  const elements: UiElement[] = [];
  for (const match of value.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1] ?? "");
    const bounds = parseBounds(attrs.get("bounds") || "");
    elements.push({
      index: elements.length,
      text: empty(attrs.get("text")),
      contentDescription: empty(attrs.get("content-desc")),
      resourceId: empty(attrs.get("resource-id")),
      className: empty(attrs.get("class")),
      bounds,
      clickable: attrs.get("clickable") === "true",
      enabled: attrs.get("enabled") !== "false",
    });
  }
  return elements;
}

function attributes(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) {
    if (match[1]) out.set(match[1], decode(match[2] ?? ""));
  }
  return out;
}

function parseBounds(value: string): Bounds | undefined {
  const match = value.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
  if (!match) return undefined;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
  };
}

export function inputText(value: string): string {
  if (value.length > MAX_INPUT_TEXT_LENGTH) throw new Error("Text input is too long.");
  return value.replace(/%/g, "%25").replace(/\s/g, "%s");
}

function elementText(item: UiElement): string {
  return [item.text, item.contentDescription, item.resourceId, item.className]
    .filter(Boolean)
    .join(" ");
}

function empty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
