import type { IServiceAccessor } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import {
  getSourceSettingsServices,
  ensureSourceSettingsServices,
  registerSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";

function createServices(name: string): IServiceAccessor {
  return { name } as unknown as IServiceAccessor;
}

describe("sourceSettingsServiceStore", () => {
  it("keeps the replacement services when the previous attachment closes late", () => {
    const sourceServerId = "source-replacement";
    const servicesA = createServices("A");
    const servicesB = createServices("B");
    const disposeA = vi.fn();
    const disposeB = vi.fn();

    const releaseA = registerSourceSettingsServices({
      sourceServerId,
      attachmentId: "attachment-a",
      services: servicesA,
      dispose: disposeA,
    });
    const releaseB = registerSourceSettingsServices({
      sourceServerId,
      attachmentId: "attachment-b",
      services: servicesB,
      dispose: disposeB,
    });

    releaseA();

    expect(getSourceSettingsServices(sourceServerId)).toBe(servicesB);
    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).not.toHaveBeenCalled();

    releaseB();
    releaseB();

    expect(getSourceSettingsServices(sourceServerId)).toBeUndefined();
    expect(disposeB).toHaveBeenCalledOnce();
  });
});

it("configuration panels share one in-flight attachment and can retry a failed request", async () => {
  let reject!: (error: Error) => void;
  const request = vi.fn(
    () =>
      new Promise<{ attachmentId: string }>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const a = ensureSourceSettingsServices("config-same", request);
  const b = ensureSourceSettingsServices("config-same", request);
  expect(a).toBe(b);
  expect(request).toHaveBeenCalledOnce();
  reject(new Error("offline"));
  await expect(a).rejects.toThrow("offline");
  const retry = vi.fn(async () => ({ attachmentId: "ready" }));
  await ensureSourceSettingsServices("config-same", retry);
  expect(retry).toHaveBeenCalledOnce();
});
