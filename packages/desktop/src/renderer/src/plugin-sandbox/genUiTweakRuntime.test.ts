import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

async function setup(send: (name: string, message: any) => Promise<unknown>) {
  const document = {};
  const listeners = new Map<string, (event: unknown) => void>();
  class Element {
    ownerDocument = document;
    isConnected = true;
    id = "component";
    localName = "div";
    parentElement = null;
    getAttribute() {
      return "Component";
    }
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 100, height: 80 };
    }
  }
  const context: any = {
    document,
    Element,
    CSS: { escape: (s: string) => s },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
    reportError: (error: unknown) => {
      throw error;
    },
    send,
  };
  const source = await readFile(new URL("./genUiTweakRuntime.js", import.meta.url), "utf8");
  runInNewContext(
    source.replace("export function", "function") + "\ninstallGenUiTweakRuntime(send);",
    context,
  );
  return {
    Tweak: context.Tweak,
    container: new Element(),
    globals: (value: unknown) =>
      listeners.get("zcode:set_globals")?.({
        detail: { globals: { visualizationAnnotation: value } },
      }),
  };
}

it("serializes registration ACKs, applies previews, and restores original values", async () => {
  const calls: any[] = [];
  const gate = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const runtime = await setup(async (_name, message) => {
    calls.push(message);
    if (calls.length === 1) await gate.promise;
    if (calls.length === 2) second.resolve();
    return { annotationControls: message.annotationControls };
  });
  const values = { size: 12, enabled: true };
  const seen: number[] = [];
  const panel = new runtime.Tweak({
    container: runtime.container,
    onChange: () => seen.push(values.size),
  });
  panel.addSlider(values, "size", { min: 0, max: 40 });
  panel.addToggle(values, "enabled");
  await new Promise(setImmediate);
  expect(calls).toHaveLength(1);
  gate.resolve();
  await second.promise;
  await new Promise(setImmediate);
  expect(calls[1].type).toBe("update");
  expect(calls[1].annotationControls.controls).toHaveLength(2);
  const control = calls[0].annotationControls.controls[0];
  const command = (value: number, previousValue = 12) => ({
    active: false,
    changes: [
      {
        registrationId: "tweak-1",
        targetId: "1",
        annotationControlChanges: [{ callback: control.callback, value, previousValue }],
      },
    ],
  });
  runtime.globals(command(20));
  expect(values.size).toBe(20);
  runtime.globals(command(30, 999));
  expect(values.size).toBe(12);
  runtime.globals(command(20));
  panel.dispose();
  await new Promise(setImmediate);
  expect(values.size).toBe(12);
  expect(calls.at(-1).type).toBe("dispose");
  expect(seen).toEqual([20, 12, 20, 12]);
});

it("rejects invalid bindings before sending and rolls back a rejected registration", async () => {
  const calls: any[] = [];
  const runtime = await setup(async (_name, message) => {
    calls.push(message);
    return {};
  });
  const panel = new runtime.Tweak({ container: runtime.container, onChange() {} });
  expect(() => panel.addSlider({ x: 20 }, "x", { min: 0, max: 10 })).toThrow();
  expect(calls).toHaveLength(0);
  panel.addToggle({ enabled: true }, "enabled");
  panel.addToggle({ enabled: false }, "enabled");
  await new Promise(setImmediate);
  expect(calls.map((call) => call.type)).toEqual(["register", "dispose"]);
  expect(() => panel.addToggle({ enabled: true }, "enabled")).toThrow();
});
